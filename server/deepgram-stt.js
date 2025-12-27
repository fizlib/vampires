// Deepgram NOVA-3 Speech-to-Text Controller
// This module handles speech-to-text transcription using Deepgram's NOVA-3 model

const { createClient } = require('@deepgram/sdk');

class DeepgramSTTController {
    constructor() {
        this.client = null;
        this.available = false;
        this.initialize();
    }

    initialize() {
        try {
            const apiKey = process.env.DEEPGRAM_API_KEY;

            if (apiKey) {
                this.client = createClient(apiKey);
                this.available = true;
                console.log('[STT] Deepgram NOVA-3 Speech-to-Text initialized successfully');
            } else {
                console.log('[STT] No Deepgram API key found (DEEPGRAM_API_KEY). Deepgram STT disabled.');
                this.available = false;
            }
        } catch (error) {
            console.log('[STT] Deepgram Speech-to-Text not available:', error.message);
            console.log('[STT] Set DEEPGRAM_API_KEY environment variable to enable Deepgram voice transcription');
            this.available = false;
        }
    }

    isAvailable() {
        return this.available;
    }

    /**
     * Transcribe audio buffer to text using Deepgram NOVA-3
     * @param {string} audioBase64 - Base64 encoded audio data (webm format from browser)
     * @param {string} language - Language code ('english', 'russian', 'lithuanian')
     * @returns {Promise<string|null>} - Transcribed text or null if failed
     */
    async recognizeStream(audioBase64, language = 'english') {
        if (!this.available || !this.client) {
            console.log('[STT] Deepgram Speech-to-Text not available');
            return null;
        }

        try {
            // Convert base64 to buffer
            const audioBuffer = Buffer.from(audioBase64, 'base64');

            // Map language setting to Deepgram language codes
            const languageCodeMap = {
                'russian': 'ru',
                'lithuanian': 'lt',
                'english': 'en'
            };
            const languageCode = languageCodeMap[language] || 'en';

            console.log(`[STT] Deepgram: Transcribing audio (${language}, ${audioBuffer.length} bytes)...`);

            // Use Deepgram's pre-recorded transcription with NOVA-3 model
            const { result, error } = await this.client.listen.prerecorded.transcribeFile(
                audioBuffer,
                {
                    model: 'nova-3',
                    language: languageCode,
                    smart_format: true,
                    punctuate: true,
                    mimetype: 'audio/webm'
                }
            );

            if (error) {
                console.error('[STT] Deepgram transcription error:', error);
                return null;
            }

            console.log('[STT] Deepgram response received');

            // Extract transcript from response
            const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

            if (!transcript) {
                console.log('[STT] Deepgram: No transcription results - audio may be too short or contain no speech');
                return null;
            }

            console.log('[STT] Deepgram transcription successful:', transcript);
            return transcript;

        } catch (error) {
            console.error('[STT] Deepgram transcription error:', error.message);
            console.error('[STT] Error details:', error);
            return null;
        }
    }
}

module.exports = DeepgramSTTController;
