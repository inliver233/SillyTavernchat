import fs from 'node:fs';
import path from 'node:path';

/**
 * Names that are commonly present but not meaningful user content.
 */
const IGNORED_ENTRY_NAMES = new Set([
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
]);

/**
 * Recursively checks whether `userDir` contains any file that is not present in `baselineDir`
 * (or differs in size). Stops early on the first detected extra file.
 *
 * @param {string} userDir
 * @param {string | null | undefined} baselineDir
 * @returns {Promise<{ hasExtra: boolean; example?: string }>}
 */
async function dirHasExtraContent(userDir, baselineDir) {
    try {
        if (!userDir || !fs.existsSync(userDir)) {
            return { hasExtra: false };
        }

        /** @type {Array<{ absPath: string; relPath: string }>} */
        const stack = [{ absPath: userDir, relPath: '' }];

        while (stack.length > 0) {
            const current = stack.pop();
            if (!current) break;

            const entries = await fs.promises.readdir(current.absPath, { withFileTypes: true });
            for (const entry of entries) {
                if (IGNORED_ENTRY_NAMES.has(entry.name)) {
                    continue;
                }

                const entryAbsPath = path.join(current.absPath, entry.name);
                const entryRelPath = path.join(current.relPath, entry.name);

                if (entry.isDirectory()) {
                    stack.push({ absPath: entryAbsPath, relPath: entryRelPath });
                    continue;
                }

                // Treat symlinks/unknowns as "extra" to avoid following unexpected paths.
                if (!entry.isFile()) {
                    return { hasExtra: true, example: entryRelPath };
                }

                if (!baselineDir) {
                    return { hasExtra: true, example: entryRelPath };
                }

                const baselinePath = path.join(baselineDir, entryRelPath);
                if (!fs.existsSync(baselinePath)) {
                    return { hasExtra: true, example: entryRelPath };
                }

                // If sizes differ, consider it user-modified content (safe false-negative approach).
                try {
                    const [userStat, baseStat] = await Promise.all([
                        fs.promises.stat(entryAbsPath),
                        fs.promises.stat(baselinePath),
                    ]);
                    if (userStat.size !== baseStat.size) {
                        return { hasExtra: true, example: entryRelPath };
                    }
                } catch {
                    return { hasExtra: true, example: entryRelPath };
                }
            }
        }

        return { hasExtra: false };
    } catch {
        // If we cannot safely determine, assume it has content (safer to not delete).
        return { hasExtra: true, example: 'unknown' };
    }
}

/**
 * Checks whether a user appears "unused" by verifying that key content directories
 * contain no files beyond the provided baseline (e.g., the default template).
 *
 * This is intentionally conservative: if we cannot confidently prove "unused",
 * we return `isUnused: false`.
 *
 * @param {import('./users.js').UserDirectoryList} userDirectories
 * @param {import('./users.js').UserDirectoryList | null | undefined} baselineDirectories
 * @returns {Promise<{ isUnused: boolean; details: Record<string, { hasExtra: boolean; example?: string }> }>}
 */
export async function checkUserIsUnused(userDirectories, baselineDirectories) {
    /** @type {Record<string, { hasExtra: boolean; example?: string }>} */
    const details = {};

    const keysToCheck = [
        // Actual user content
        'chats',
        'groupChats',
        'characters',
        'worlds',
        'groups',
        'files',
        'comfyWorkflows',
        'userImages',

        // Presets/config that may indicate usage
        'instruct',
        'context',
        'sysprompt',
        'reasoning',
        'quickreplies',
        'openAI_Settings',
        'koboldAI_Settings',
        'novelAI_Settings',
        'textGen_Settings',
    ];

    for (const key of keysToCheck) {
        const userDir = userDirectories?.[key];
        const baselineDir = baselineDirectories?.[key] || null;
        details[key] = await dirHasExtraContent(userDir, baselineDir);
        if (details[key].hasExtra) {
            return { isUnused: false, details };
        }
    }

    return { isUnused: true, details };
}

