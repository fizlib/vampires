/**
 * ElevenLabs Text-to-Speech Controller
 * Provides TTS synthesis using the ElevenLabs API
 */

// Available ElevenLabs models
const ELEVENLABS_MODELS = [
    { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5 (Fast, English)', language: 'english' },
    { id: 'eleven_flash_v2_5', name: 'Flash v2.5 (Fastest)', language: 'multilingual' },
    { id: 'eleven_multilingual_v2', name: 'Multilingual v2', language: 'multilingual' },
    { id: 'eleven_v3', name: 'Eleven V3 (Best Quality)', language: 'multilingual' },
    { id: 'eleven_turbo_v2', name: 'Turbo v2', language: 'english' },
    { id: 'eleven_monolingual_v1', name: 'English v1', language: 'english' }
];

// Available voices from ElevenLabs (using their pre-made voices)
const ELEVENLABS_VOICES = [
    { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', gender: 'male' },
    { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', gender: 'male' },
    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', gender: 'female' },
    { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', gender: 'female' },
    { id: '9BWtsMINqrJLrRacOk9x', name: 'Aria', gender: 'female' },
    { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger', gender: 'male' },
    { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', gender: 'female' },
    { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', gender: 'male' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', gender: 'female' },
    { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', gender: 'male' }
];

class ElevenLabsTTSController {
    constructor() {
        this.client = null;
        this.enabled = false;
        this.npcVoices = {}; // Store assigned voice per NPC for consistency
        this.apiKey = process.env.ELEVENLABS_API_KEY || '';

        // Initialize if API key is available
        this.initialize();
    }

    async initialize() {
        if (!this.apiKey) {
            console.log('[ElevenLabs] No API key found (ELEVENLABS_API_KEY). ElevenLabs TTS disabled.');
            return;
        }

        try {
            // Dynamic import for ES module
            const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
            this.client = new ElevenLabsClient({ apiKey: this.apiKey });
            this.enabled = true;
            console.log('[ElevenLabs] Text-to-Speech initialized successfully');
        } catch (error) {
            console.error('[ElevenLabs] Failed to initialize:', error.message);
            this.enabled = false;
        }
    }

    /**
     * Get available models
     */
    static getAvailableModels() {
        return ELEVENLABS_MODELS;
    }

    /**
     * Get available voices
     */
    static getAvailableVoices() {
        return ELEVENLABS_VOICES;
    }

    /**
     * Get or assign a consistent voice for an NPC
     * @param {string} npcId - The NPC's unique ID
     * @param {string} voiceIdOverride - Optional specific voice ID to use
     * @returns {object} Voice configuration
     */
    getVoiceForNPC(npcId, voiceIdOverride = null) {
        // If a specific voice override is provided, use it
        if (voiceIdOverride) {
            const voice = ELEVENLABS_VOICES.find(v => v.id === voiceIdOverride);
            if (voice) {
                this.npcVoices[npcId] = voice;
                console.log(`[ElevenLabs] Using custom voice ${voice.name} for NPC ${npcId}`);
                return voice;
            }
        }

        // Return existing assignment if any
        if (this.npcVoices[npcId]) {
            return this.npcVoices[npcId];
        }

        // Assign random voice
        const selectedVoice = ELEVENLABS_VOICES[Math.floor(Math.random() * ELEVENLABS_VOICES.length)];
        this.npcVoices[npcId] = selectedVoice;
        console.log(`[ElevenLabs] Assigned voice ${selectedVoice.name} to NPC ${npcId}`);
        return selectedVoice;
    }

    /**
     * Synthesize speech from text
     * @param {string} text - The text to convert to speech
     * @param {string} npcId - The NPC's ID for voice consistency
     * @param {string} nationality - Language preference (unused, kept for interface compatibility)
     * @param {object} options - Optional overrides { voiceId, modelId }
     * @returns {Promise<string|null>} Base64 encoded audio or null on failure
     */
    async synthesizeSpeech(text, npcId, nationality = 'english', options = {}) {
        if (!this.enabled || !this.client) {
            console.log('[ElevenLabs] TTS not enabled, skipping synthesis');
            return null;
        }

        if (!text || text.trim().length === 0) {
            return null;
        }

        try {
            const voice = this.getVoiceForNPC(npcId, options.voiceId);
            const modelId = options.modelId || 'eleven_turbo_v2_5';

            console.log(`[ElevenLabs] Synthesizing with model ${modelId}, voice ${voice.name}: "${text.substring(0, 50)}..."`);

            const audioStream = await this.client.textToSpeech.convert(voice.id, {
                text: text,
                modelId: modelId,
                outputFormat: 'mp3_44100_128'
            });

            // Convert Web ReadableStream to buffer then to base64
            const chunks = [];
            const reader = audioStream.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            const audioBuffer = Buffer.concat(chunks);
            const audioBase64 = audioBuffer.toString('base64');

            console.log(`[ElevenLabs] Successfully generated ${audioBase64.length} bytes of audio`);
            return audioBase64;
        } catch (error) {
            console.error('[ElevenLabs] Speech synthesis failed:', error.message);
            return null;
        }
    }

    /**
     * Clear voice assignments (call when game ends/resets)
     */
    clearVoiceAssignments() {
        this.npcVoices = {};
        console.log('[ElevenLabs] Cleared NPC voice assignments');
    }

    /**
     * Check if TTS is available and enabled
     */
    isAvailable() {
        return this.enabled && this.client !== null;
    }
}

module.exports = ElevenLabsTTSController;
