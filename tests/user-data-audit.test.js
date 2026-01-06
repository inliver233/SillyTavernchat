import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkUserIsUnused } from '../src/user-data-audit.js';

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavernchat-user-audit-'));
}

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

describe('checkUserIsUnused', () => {
    it('returns true when all checked directories are empty/missing', async () => {
        const root = makeTempDir();

        const userDirectories = {
            chats: path.join(root, 'chats'),
            groupChats: path.join(root, 'group chats'),
            characters: path.join(root, 'characters'),
            worlds: path.join(root, 'worlds'),
            groups: path.join(root, 'groups'),
            files: path.join(root, 'user/files'),
            comfyWorkflows: path.join(root, 'user/workflows'),
            userImages: path.join(root, 'user/images'),
            instruct: path.join(root, 'instruct'),
            context: path.join(root, 'context'),
            sysprompt: path.join(root, 'sysprompt'),
            reasoning: path.join(root, 'reasoning'),
            quickreplies: path.join(root, 'QuickReplies'),
            openAI_Settings: path.join(root, 'OpenAI Settings'),
            koboldAI_Settings: path.join(root, 'KoboldAI Settings'),
            novelAI_Settings: path.join(root, 'NovelAI Settings'),
            textGen_Settings: path.join(root, 'TextGen Settings'),
        };

        const result = await checkUserIsUnused(userDirectories, null);
        expect(result.isUnused).toBe(true);
    });

    it('returns false when user has extra chat file (no baseline)', async () => {
        const root = makeTempDir();
        const chatsDir = path.join(root, 'chats');
        writeFile(path.join(chatsDir, 'chat1.json'), '{"test":true}');

        const userDirectories = {
            chats: chatsDir,
        };

        const result = await checkUserIsUnused(userDirectories, null);
        expect(result.isUnused).toBe(false);
        expect(result.details.chats.hasExtra).toBe(true);
    });

    it('treats baseline files as not extra when path and size match', async () => {
        const root = makeTempDir();
        const userInstruct = path.join(root, 'user', 'instruct');
        const baseInstruct = path.join(root, 'base', 'instruct');

        writeFile(path.join(userInstruct, 'preset.json'), '{"a":1}');
        writeFile(path.join(baseInstruct, 'preset.json'), '{"a":1}');

        const userDirectories = { instruct: userInstruct };
        const baselineDirectories = { instruct: baseInstruct };

        const result = await checkUserIsUnused(userDirectories, baselineDirectories);
        expect(result.isUnused).toBe(true);
    });

    it('treats modified baseline files as extra when size differs', async () => {
        const root = makeTempDir();
        const userWorlds = path.join(root, 'user', 'worlds');
        const baseWorlds = path.join(root, 'base', 'worlds');

        writeFile(path.join(userWorlds, 'wi.json'), '{"a":1,"b":2}');
        writeFile(path.join(baseWorlds, 'wi.json'), '{"a":1}');

        const userDirectories = { worlds: userWorlds };
        const baselineDirectories = { worlds: baseWorlds };

        const result = await checkUserIsUnused(userDirectories, baselineDirectories);
        expect(result.isUnused).toBe(false);
        expect(result.details.worlds.hasExtra).toBe(true);
    });
});

