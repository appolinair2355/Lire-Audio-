const express = require('express');
const multer = require('multer');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = 'd7375fe5dce6bc15c226281b6d8da5c1364ba401';

// Stockage mémoire (pas de fichiers sur disque)
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static('.'));

// Page principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Transcription fichier uploadé
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  
  try {
    const deepgram = createClient(DEEPGRAM_API_KEY);
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      req.file.buffer,
      { model: 'nova-2', language: 'fr', smart_format: true, utterances: true }
    );
    
    if (error) throw error;
    
    const alternative = result.results.channels[0].alternatives[0];
    res.json({ 
      transcript: alternative.transcript,
      words: alternative.words || [],
      utterances: result.results.utterances || []
    });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// WebSocket pour transcription temps réel (streaming)
wss.on('connection', (ws) => {
  console.log('Client connecté');
  let deepgramConnection = null;
  
  ws.on('message', async (data) => {
    // Initialisation
    if (data.toString() === 'START') {
      try {
        const deepgram = createClient(DEEPGRAM_API_KEY);
        deepgramConnection = deepgram.listen.live({
          model: 'nova-2',
          language: 'fr',
          interim_results: true,
          smart_format: true,
          encoding: 'linear16',
          sample_rate: 16000
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
          console.log('Deepgram connection opened');
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Transcript, (transcription) => {
          const text = transcription.channel.alternatives[0].transcript;
          const isFinal = transcription.is_final;
          if (text) {
            ws.send(JSON.stringify({ text, isFinal, timestamp: Date.now() }));
          }
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
          console.error('Deepgram error:', err);
          ws.send(JSON.stringify({ error: err.message }));
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Close, () => {
          console.log('Deepgram connection closed');
        });
      } catch (err) {
        console.error('Setup error:', err);
        ws.send(JSON.stringify({ error: 'Failed to initialize transcription' }));
      }
    }
    // Audio chunks
    else if (deepgramConnection && Buffer.isBuffer(data)) {
      try {
        deepgramConnection.send(data);
      } catch (err) {
        console.error('Send error:', err);
      }
    }
    // Fin
    else if (data.toString() === 'STOP' && deepgramConnection) {
      try {
        deepgramConnection.requestClose();
      } catch (err) {
        console.error('Close error:', err);
      }
      deepgramConnection = null;
    }
  });
  
  ws.on('close', () => {
    console.log('Client déconnecté');
    if (deepgramConnection) {
      try {
        deepgramConnection.requestClose();
      } catch (err) {
        console.error('Cleanup error:', err);
      }
      deepgramConnection = null;
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Deepgram API configured`);
});
