const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
const port = process.env.PORT || 3000;

console.log('Starting app with env:', {
  TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID: !!process.env.TWILIO_CALLER_ID,
  SPEECHMATICS_API_KEY: !!process.env.SPEECHMATICS_API_KEY,
  FLY_APP_NAME: process.env.FLY_APP_NAME
});

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const wss = new WebSocketServer({ port: 8080, host: '0.0.0.0' }, () => {
  console.log('WebSocket server started on port 8080');
});
wss.on('error', (error) => console.error('WebSocket server error:', error.message));
let speechmaticsWs;

async function fetchSpeechmaticsJWT() {
  try {
    const response = await axios.post(
      'https://mp.speechmatics.com/v1/api_keys?type=rt',
      { ttl: 3600 },
      { headers: { 'Authorization': `Bearer ${process.env.SPEECHMATICS_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    process.env.SPEECHMATICS_JWT = response.data.key_value;
    console.log('New JWT fetched:', process.env.SPEECHMATICS_JWT.slice(0, 10) + '...');
  } catch (error) {
    console.error('JWT fetch error:', error.message);
  }
}

// Fetch JWT on startup and every 50 minutes (JWT valid for 60 minutes)
fetchSpeechmaticsJWT();
setInterval(fetchSpeechmaticsJWT, 50 * 60 * 1000);

function connectToSpeechmatics() {
  if (speechmaticsWs && speechmaticsWs.readyState === WebSocket.OPEN) return;
  console.log('Using JWT:', process.env.SPEECHMATICS_JWT ? 'Set' : 'Unset');
  speechmaticsWs = new WebSocket(`wss://eu2.rt.speechmatics.com/v2/en?jwt=${process.env.SPEECHMATICS_JWT}`);
  speechmaticsWs.on('open', () => {
    console.log('Connected to Speechmatics');
    speechmaticsWs.send(JSON.stringify({
      message: 'StartRecognition',
      audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 8000 },
      transcription_config: { language: 'en' }
    }));
  });
  speechmaticsWs.on('message', async (data) => {
    console.log('Speechmatics message:', data.toString());
    const transcription = JSON.parse(data);
    if (transcription.message === 'AddTranscript') {
      const callInfo = global.currentCall || { callId: 'test-call', phoneNumber: 'unknown' };
      const jsonData = {
        callId: callInfo.callId,
        phoneNumber: callInfo.phoneNumber,
        timestamp: new Date().toISOString(),
        transcription: transcription.results.map(r => ({
          text: r.text,
          startTime: r.start_time,
          endTime: r.end_time
        }))
      };
      await fs.writeFile(`transcription_${callInfo.callId}_${Date.now()}.json`, JSON.stringify(jsonData, null, 2));
      console.log('Transcription saved:', jsonData);
    }
  });
  speechmaticsWs.on('error', (error) => console.error('Speechmatics WS Error:', error.message));
  speechmaticsWs.on('close', (code, reason) => {
    console.log(`Speechmatics WS Closed: Code=${code}, Reason=${reason.toString()}`);
    setTimeout(connectToSpeechmatics, 5000);
  });
}

connectToSpeechmatics();

wss.on('connection', (ws) => {
  console.log('Twilio WebSocket connected');
  ws.on('message', (message) => {
    console.log('Twilio WS message:', message.toString());
    const data = JSON.parse(message);
    if (data.event === 'media') {
      console.log('Received Twilio audio chunk');
      const audio = Buffer.from(data.media.payload, 'base64');
      if (speechmaticsWs && speechmaticsWs.readyState === WebSocket.OPEN) {
        speechmaticsWs.send(audio);
        console.log('Sent audio to Speechmatics');
      } else {
        console.log('Speechmatics WS not open');
      }
    } else if (data.event === 'start') {
      console.log('Call started:', data.start.callSid);
    }
  });
  ws.on('error', (error) => console.error('Twilio WS Error:', error.message));
  ws.on('close', () => console.log('Twilio WebSocket closed'));
});

app.post('/voice', (req, res) => {
  console.log('Received Twilio webhook');
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  global.currentCall = { callId: req.body.CallSid, phoneNumber: req.body.To };
  const connect = response.connect();
  connect.stream({ url: `wss://${process.env.FLY_APP_NAME}.fly.dev` });
  const dial = response.dial();
  dial.number({ callerId: process.env.TWILIO_CALLER_ID }, '+498941434044');
  res.type('text/xml');
  res.send(response.toString());
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});