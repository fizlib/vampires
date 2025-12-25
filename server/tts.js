const textToSpeech = require('@google-cloud/text-to-speech');

// Voice options for variety
const VOICES = {
    english: [
        { name: 'en-US-Neural2-A', gender: 'MALE' },
        { name: 'en-US-Neural2-C', gender: 'FEMALE' },
        { name: 'en-US-Neural2-D', gender: 'MALE' },
        { name: 'en-US-Neural2-E', gender: 'FEMALE' },
        { name: 'en-US-Neural2-F', gender: 'FEMALE' },
        { name: 'en-US-Neural2-G', gender: 'FEMALE' },
        { name: 'en-US-Neural2-H', gender: 'FEMALE' },
        { name: 'en-US-Neural2-I', gender: 'MALE' },
        { name: 'en-US-Neural2-J', gender: 'MALE' }
    ],
    lithuanian: [
        // Lithuanian voices available in Google Cloud TTS
        { name: 'lt-LT-Standard-A', gender: 'MALE' }
    ]
};

class TTSController {
    constructor() {
        this.client = null;
        this.enabled = false;
        this.npcVoices = {}; // Store assigned voice per NPC for consistency

        // Initialize client based on available credentials
        try {
            // Check for credentials file or API key
            if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_TTS_API_KEY) {
                if (process.env.GOOGLE_TTS_API_KEY) {
                    this.client = new textToSpeech.TextToSpeechClient({
                        apiKey: process.env.GOOGLE_TTS_API_KEY
                    });
                } else {
                    this.client = new textToSpeech.TextToSpeechClient();
                }
                this.enabled = true;
                console.log('[TTS] Google Cloud Text-to-Speech initialized successfully');
            } else {
                console.log('[TTS] No Google Cloud credentials found (GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_TTS_API_KEY). TTS disabled.');
            }
        } catch (error) {
            console.error('[TTS] Failed to initialize Text-to-Speech client:', error.message);
            this.enabled = false;
        }
    }

    /**
     * Get or assign a consistent voice for an NPC
     * @param {string} npcId - The NPC's unique ID
     * @param {string} nationality - Language preference ('english' or 'lithuanian')
     * @returns {object} Voice configuration
     */
    getVoiceForNPC(npcId, nationality = 'english') {
        if (this.npcVoices[npcId]) {
            return this.npcVoices[npcId];
        }

        const voiceList = VOICES[nationality] || VOICES.english;
        const selectedVoice = voiceList[Math.floor(Math.random() * voiceList.length)];

        this.npcVoices[npcId] = selectedVoice;
        console.log(`[TTS] Assigned voice ${selectedVoice.name} to NPC ${npcId}`);
        return selectedVoice;
    }

    /**
     * Synthesize speech from text
     * @param {string} text - The text to convert to speech
     * @param {string} npcId - The NPC's ID for voice consistency
     * @param {string} nationality - Language preference
     * @returns {Promise<string|null>} Base64 encoded audio or null on failure
     */
    async synthesizeSpeech(text, npcId, nationality = 'english') {
        if (!this.enabled || !this.client) {
            console.log('[TTS] TTS not enabled, skipping synthesis');
            return null;
        }

        if (!text || text.trim().length === 0) {
            return null;
        }

        try {
            const voice = this.getVoiceForNPC(npcId, nationality);
            const languageCode = nationality === 'lithuanian' ? 'lt-LT' : 'en-US';

            const request = {
                input: { text: text },
                voice: {
                    languageCode: languageCode,
                    name: voice.name,
                    ssmlGender: voice.gender
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    speakingRate: 1.0,
                    pitch: 0
                }
            };

            console.log(`[TTS] Synthesizing speech for: "${text.substring(0, 50)}..."`);
            const [response] = await this.client.synthesizeSpeech(request);

            // Convert to base64 for socket transmission
            const audioBase64 = response.audioContent.toString('base64');
            console.log(`[TTS] Successfully generated ${audioBase64.length} bytes of audio`);

            return audioBase64;
        } catch (error) {
            console.error('[TTS] Speech synthesis failed:', error.message);
            return null;
        }
    }

    /**
     * Clear voice assignments (call when game ends/resets)
     */
    clearVoiceAssignments() {
        this.npcVoices = {};
        console.log('[TTS] Cleared NPC voice assignments');
    }

    /**
     * Check if TTS is available and enabled
     */
    isAvailable() {
        return this.enabled && this.client !== null;
    }
}

module.exports = TTSController;
