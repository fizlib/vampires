// Google Cloud Speech-to-Text Controller
// This module handles speech-to-text transcription using Google Cloud Speech API

const speech = require('@google-cloud/speech');

class GoogleSTTController {
    constructor() {
        this.client = null;
        this.available = false;
        this.initialize();
    }

    initialize() {
        try {
            // Try to initialize the Google Cloud Speech client
            // It will use GOOGLE_APPLICATION_CREDENTIALS environment variable
            // or default credentials if available
            this.client = new speech.SpeechClient();
            this.available = true;
            console.log('[STT] Google Cloud Speech-to-Text initialized successfully');
        } catch (error) {
            console.log('[STT] Google Cloud Speech-to-Text not available:', error.message);
            console.log('[STT] Set GOOGLE_APPLICATION_CREDENTIALS environment variable to enable voice chat');
            this.available = false;
        }
    }

    isAvailable() {
        return this.available;
    }

    /**
     * Transcribe audio buffer to text
     * @param {string} audioBase64 - Base64 encoded audio data (webm format from browser)
     * @param {string} language - Language code ('english' or 'russian')
     * @returns {Promise<string|null>} - Transcribed text or null if failed
     */
    async recognizeStream(audioBase64, language = 'english') {
        if (!this.available || !this.client) {
            console.log('[STT] Speech-to-Text not available');
            return null;
        }

        try {
            // Convert base64 to buffer
            const audioBuffer = Buffer.from(audioBase64, 'base64');

            // Map language setting to Google language codes
            const languageCode = language === 'russian' ? 'ru-RU' : 'en-US';

            console.log(`[STT] Transcribing audio (${language}, ${audioBuffer.length} bytes)...`);

            // Try with encoding auto-detection first (let Google figure it out)
            const request = {
                audio: {
                    content: audioBuffer,
                },
                config: {
                    // Remove explicit encoding - let Google auto-detect
                    languageCode: languageCode,
                    enableAutomaticPunctuation: true,
                    model: 'default',
                },
            };

            // Perform the transcription
            const [response] = await this.client.recognize(request);

            console.log('[STT] Response received:', JSON.stringify(response, null, 2));

            if (!response.results || response.results.length === 0) {
                console.log('[STT] No transcription results - audio may be too short or contain no speech');
                return null;
            }

            // Get the transcript from the first result
            const transcription = response.results
                .map(result => result.alternatives[0].transcript)
                .join('\n');

            console.log('[STT] Transcription successful:', transcription);
            return transcription;

        } catch (error) {
            console.error('[STT] Transcription error:', error.message);
            console.error('[STT] Error details:', error);

            return null;
        }
    }
}

module.exports = GoogleSTTController;
