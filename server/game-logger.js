/**
 * Game Logger Module
 * Captures server console output and NPC context memory for each game session.
 */

const fs = require('fs');
const path = require('path');

class GameLogger {
    constructor(gameCode) {
        this.gameCode = gameCode;
        this.startTime = new Date();
        this.consoleBuffer = [];
        this.originalConsoleLog = null;
        this.isCapturing = false;
    }

    /**
     * Start capturing console.log output for this game
     */
    startCapture() {
        if (this.isCapturing) return;

        this.originalConsoleLog = console.log;
        this.isCapturing = true;

        // Intercept console.log
        console.log = (...args) => {
            // Always call original console.log first
            this.originalConsoleLog.apply(console, args);

            // Capture messages with [Game] or [AI] prefixes
            const message = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');

            if (message.includes('[Game]') || message.includes('[AI]')) {
                const timestamp = new Date().toISOString();
                this.consoleBuffer.push(`[${timestamp}] ${message}`);
            }
        };
    }

    /**
     * Stop capturing console output and restore original console.log
     */
    stopCapture() {
        if (!this.isCapturing) return;

        if (this.originalConsoleLog) {
            console.log = this.originalConsoleLog;
            this.originalConsoleLog = null;
        }
        this.isCapturing = false;
    }

    /**
     * Generate the log folder path for this game
     */
    getLogFolderPath() {
        const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-');
        const folderName = `game_${this.gameCode}_${timestamp}`;
        return path.join(__dirname, 'logs', folderName);
    }

    /**
     * Ensure the logs directory and game folder exist
     */
    ensureLogFolder() {
        const folderPath = this.getLogFolderPath();
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }
        return folderPath;
    }

    /**
     * Save the console buffer to server-console.log
     */
    saveConsoleLog() {
        try {
            const folderPath = this.ensureLogFolder();
            const filePath = path.join(folderPath, 'server-console.log');

            const content = this.consoleBuffer.length > 0
                ? this.consoleBuffer.join('\n')
                : '(No console output captured)';

            fs.writeFileSync(filePath, content, 'utf8');
            return filePath;
        } catch (err) {
            console.error('[GameLogger] Failed to save console log:', err);
            return null;
        }
    }

    /**
     * Format a single NPC's context for the log
     */
    formatNPCContext(npc) {
        let output = '';
        output += `\n${'='.repeat(40)}\n`;
        output += `NPC: ${npc.name}\n`;
        output += `${'='.repeat(40)}\n`;
        output += `Role: ${npc.role} (${npc.alignment})\n`;
        output += `Status: ${npc.alive ? 'Alive' : 'Dead'}${npc.isTurned ? ' (Turned to Vampire)' : ''}\n`;

        if (npc.personality) {
            output += `Personality: ${npc.personality}\n`;
        }
        if (npc.talkingStyle) {
            output += `Talking Style: ${npc.talkingStyle}\n`;
        }
        if (npc.background) {
            output += `Background: ${npc.background}\n`;
        }
        if (npc.gender) {
            output += `Gender: ${npc.gender}\n`;
        }
        if (npc.fakeRole) {
            output += `Fake Role (claimed): ${npc.fakeRole}\n`;
        }

        // Action history
        if (npc.actionHistory && npc.actionHistory.length > 0) {
            output += `\nACTION HISTORY:\n`;
            for (const action of npc.actionHistory) {
                let line = `- Night ${action.round}: ${action.action} on ${action.targetName}`;
                if (action.result) {
                    line += ` → RESULT: ${action.result}`;
                }
                output += line + '\n';
            }
        } else {
            output += `\nACTION HISTORY: (No actions recorded)\n`;
        }

        return output;
    }

    /**
     * Save all NPC context to npc-context.log
     * @param {Array} players - Array of all players in the game
     */
    saveNPCContext(players) {
        try {
            const folderPath = this.ensureLogFolder();
            const filePath = path.join(folderPath, 'npc-context.log');

            const endTime = new Date().toISOString();
            const npcs = players.filter(p => p.isNPC);

            let content = '';
            content += `=== GAME NPC CONTEXT MEMORY REPORT ===\n`;
            content += `Game Code: ${this.gameCode}\n`;
            content += `Start Time: ${this.startTime.toISOString()}\n`;
            content += `End Time: ${endTime}\n`;
            content += `Total NPCs: ${npcs.length}\n`;

            if (npcs.length === 0) {
                content += `\n(No NPCs in this game)\n`;
            } else {
                for (const npc of npcs) {
                    content += this.formatNPCContext(npc);
                }
            }

            content += `\n${'='.repeat(40)}\n`;
            content += `END OF REPORT\n`;
            content += `${'='.repeat(40)}\n`;

            fs.writeFileSync(filePath, content, 'utf8');
            return filePath;
        } catch (err) {
            console.error('[GameLogger] Failed to save NPC context:', err);
            return null;
        }
    }

    /**
     * Save all logs and stop capturing
     * @param {Array} players - Array of all players in the game
     */
    saveLogs(players) {
        // Stop capturing first to restore console.log
        this.stopCapture();

        // Use the original console.log for our status messages
        const log = this.originalConsoleLog || console.log;

        const consolePath = this.saveConsoleLog();
        const npcPath = this.saveNPCContext(players);

        if (consolePath && npcPath) {
            log(`[GameLogger] Logs saved to: ${this.getLogFolderPath()}`);
        }

        return {
            consoleLogPath: consolePath,
            npcContextPath: npcPath,
            folderPath: this.getLogFolderPath()
        };
    }
}

module.exports = GameLogger;
