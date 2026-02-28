const express = require('express');
const multer = require('multer');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = 'd7375fe5dce6bc15c226281b6d8da5c1364ba401';

// CORS - IMPORTANT pour Render
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.static('.'));

// Stockage mémoire
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// Page principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check pour Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Transcription fichier uploadé
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  
  console.log('Received file:', req.file.originalname, 'Size:', req.file.size);
  
  try {
    const deepgram = createClient(DEEPGRAM_API_KEY);
    
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      req.file.buffer,
      { 
        model: 'nova-2', 
        language: 'fr', 
        smart_format: true,
        utterances: true,
        punctuate: true
      }
    );
    
    if (error) {
      console.error('Deepgram error:', error);
      throw error;
    }
    
    console.log('Transcription successful');
    const alternative = result.results.channels[0].alternatives[0];
    
    res.json({ 
      transcript: alternative.transcript,
      words: alternative.words || [],
      confidence: alternative.confidence
    });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

// WebSocket pour temps réel
wss.on('connection', (ws, req) => {
  console.log('WebSocket client connected from:', req.socket.remoteAddress);
  let deepgramConnection = null;
  let isSetup = false;
  
  ws.on('message', async (data) => {
    try {
      const message = data.toString();
      
      // Initialisation
      if (message === 'START') {
        if (isSetup) return;
        isSetup = true;
        
        console.log('Starting live transcription...');
        const deepgram = createClient(DEEPGRAM_API_KEY);
        
        deepgramConnection = deepgram.listen.live({
          model: 'nova-2',
          language: 'fr',
          interim_results: true,
          smart_format: true,
          encoding: 'linear16',
          sample_rate: 16000,
          channels: 1
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
          console.log('Deepgram live connection opened');
          ws.send(JSON.stringify({ status: 'ready' }));
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Transcript, (transcription) => {
          const alt = transcription.channel.alternatives[0];
          const text = alt.transcript;
          const isFinal = transcription.is_final;
          
          if (text && text.trim()) {
            ws.send(JSON.stringify({ 
              text: text.trim(), 
              isFinal, 
              timestamp: Date.now(),
              confidence: alt.confidence
            }));
          }
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
          console.error('Deepgram error:', err);
          ws.send(JSON.stringify({ error: err.message || 'Transcription error' }));
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Close, () => {
          console.log('Deepgram connection closed');
        });
        
        deepgramConnection.on(LiveTranscriptionEvents.Metadata, (metadata) => {
          console.log('Metadata received');
        });
      }
      // Audio binaire
      else if (Buffer.isBuffer(data) && deepgramConnection) {
        if (deepgramConnection.getReadyState && deepgramConnection.getReadyState() === 1) {
          deepgramConnection.send(data);
        }
      }
      // Stop
      else if (message === 'STOP') {
        console.log('Stopping transcription...');
        if (deepgramConnection) {
          deepgramConnection.requestClose();
          deepgramConnection = null;
        }
        isSetup = false;
        ws.send(JSON.stringify({ status: 'stopped' }));
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
      ws.send(JSON.stringify({ error: err.message }));
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    if (deepgramConnection) {
      try {
        deepgramConnection.requestClose();
      } catch (e) {}
      deepgramConnection = null;
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🎯 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Deepgram API: ${DEEPGRAM_API_KEY ? 'Configured' : 'Missing'}`);
});
