import { promises as fsPromises } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import {
    KEY_PREFIX,
    toKey,
    toAvatarKey,
    requireAdminMiddleware,
    getUserAvatar,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
    normalizeHandle,
} from '../users.js';
import { applyDefaultTemplateToUser, getDefaultTemplateInfo } from '../default-template.js';
import { DEFAULT_USER } from '../constants.js';
import systemMonitor from '../system-monitor.js';
import { isEmailServiceAvailable, sendInactiveUserDeletionNotice } from '../email-service.js';
import { checkUserIsUnused } from '../user-data-audit.js';


export const router = express.Router();

/**
 * @typedef {import('../users.js').UserViewModel & {
 *   loadStats?: {
 *     loadPercentage?: number;
 *     totalMessages?: number;
 *     lastActivityFormatted?: string;
 *   } | null,
 *   storageSize?: number
 * }} AdminUserViewModel
 */

/**
 * 递归计算目录大小（字节）
 * @param {string} dirPath - 目录路径
 * @returns {Promise<number>} - 目录大小（字节）
 */
async function calculateDirectorySize(dirPath) {
    let totalSize = 0;

    try {
        if (!fs.existsSync(dirPath)) {
            return 0;
        }

        const items = await fsPromises.readdir(dirPath);

        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = await fsPromises.stat(itemPath);

            if (stats.isDirectory()) {
                totalSize += await calculateDirectorySize(itemPath);
            } else {
                totalSize += stats.size;
            }
        }
    } catch (error) {
        console.error('Error calculating directory size:', error);
    }

    return totalSize;
}

router.post('/get', requireAdminMiddleware, async (request, response) => {
    try {
        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        // 是否计算存储大小（默认为false以提高性能）
        const includeStorageSize = request.body?.includeStorageSize === true;

        /** @type {Promise<AdminUserViewModel>[]} */
        const viewModelPromises = users
            .map(user => new Promise(async (resolve) => {
                const avatar = await getUserAvatar(user.handle);
                // 获取用户负载统计（如果可用）
                const loadStats = systemMonitor.getUserLoadStats(user.handle);

                // 只有在明确请求时才计算用户目录大小
                let storageSize = undefined;
                if (includeStorageSize) {
                    const directories = getUserDirectories(user.handle);
                    storageSize = await calculateDirectorySize(directories.root);
                }

                resolve({
                    handle: user.handle,
                    name: user.name,
                    avatar: avatar,
                    admin: user.admin,
                    enabled: user.enabled,
                    created: user.created,
                    password: !!user.password,
                    email: user.email || undefined,
                    storageSize: storageSize,
                    expiresAt: user.expiresAt || null,
                    loadStats: loadStats ? {
                        loadPercentage: loadStats.loadPercentage,
                        totalMessages: loadStats.totalMessages,
                        lastActivityFormatted: loadStats.lastActivityFormatted,
                    } : null,
                });
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * 获取指定用户的存储占用大小
 * 支持单个用户或批量查询
 */
router.post('/storage-size', requireAdminMiddleware, async (request, response) => {
    try {
        const { handles } = request.body;

        if (!handles || !Array.isArray(handles) || handles.length === 0) {
            console.warn('Get storage size failed: Missing or invalid handles');
            return response.status(400).json({ error: 'Missing or invalid handles array' });
        }

        const results = {};

        // 并行计算所有用户的存储大小
        await Promise.all(handles.map(async (handle) => {
            try {
                const normalizedHandle = normalizeHandle(handle);
                if (!normalizedHandle) {
                    results[handle] = { error: 'Invalid handle format' };
                    return;
                }

                const directories = getUserDirectories(normalizedHandle);
                const storageSize = await calculateDirectorySize(directories.root);
                results[normalizedHandle] = { storageSize };
            } catch (error) {
                console.error(`Error calculating storage size for ${handle}:`, error);
                results[handle] = { error: error.message };
            }
        }));

        return response.json(results);
    } catch (error) {
        console.error('Get storage size failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/disable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Disable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Disable user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        if (normalizedHandle === request.user.profile.handle) {
            console.warn('Disable user failed: Cannot disable yourself');
            return response.status(400).json({ error: 'Cannot disable yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Disable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = false;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User disable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/enable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Enable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Enable user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Enable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = true;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User enable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/promote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Promote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Promote user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Promote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = true;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User promote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/demote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Demote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Demote user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        if (normalizedHandle === request.user.profile.handle) {
            console.warn('Demote user failed: Cannot demote yourself');
            return response.status(400).json({ error: 'Cannot demote yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            console.error('Demote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = false;
        await storage.setItem(toKey(normalizedHandle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User demote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle || !request.body.name) {
            console.warn('Create user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const handles = await getAllUserHandles();
        // 使用统一的规范化函数
        const handle = normalizeHandle(request.body.handle);

        if (!handle) {
            console.warn('Create user failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

        if (handles.some(x => x === handle)) {
            console.warn('Create user failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const password = request.body.password ? getPasswordHash(request.body.password, salt) : '';

        const newUser = {
            handle: handle,
            name: request.body.name || 'Anonymous',
            created: Date.now(),
            password: password,
            salt: salt,
            admin: !!request.body.admin,
            enabled: true,
            expiresAt: null, // 管理员创建的用户默认为永久账户
        };

        await storage.setItem(toKey(handle), newUser);

        // Create user directories
        console.info('Creating data directories for', newUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        applyDefaultTemplateToUser(directories, { userName: newUser.name });
        return response.json({ handle: newUser.handle });
    } catch (error) {
        console.error('User create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Delete user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Delete user failed: Cannot delete yourself');
            return response.status(400).json({ error: 'Cannot delete yourself' });
        }

        if (request.body.handle === DEFAULT_USER.handle) {
            console.warn('Delete user failed: Cannot delete default user');
            return response.status(400).json({ error: 'Sorry, but the default user cannot be deleted. It is required as a fallback.' });
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(request.body.handle);

        if (!normalizedHandle) {
            console.warn('Delete user failed: Invalid handle format');
            return response.status(400).json({ error: 'Invalid handle format' });
        }

        await storage.removeItem(toKey(normalizedHandle));
        await storage.removeItem(toAvatarKey(normalizedHandle));
        systemMonitor.resetUserStats(normalizedHandle);

        if (request.body.purge) {
            const directories = getUserDirectories(normalizedHandle);
            console.info('Deleting data directories for', normalizedHandle);
            await fsPromises.rm(directories.root, { recursive: true, force: true });
        }

        console.info('Deleted user:', normalizedHandle, 'purge:', !!request.body.purge);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/slugify', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.text) {
            console.warn('Slugify failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        // 使用统一的规范化函数
        const text = normalizeHandle(request.body.text);

        return response.send(text);
    } catch (error) {
        console.error('Slugify failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * 清理单个用户的备份文件
 */
router.post('/clear-backups', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Clear backups failed: Missing required fields');
            return response.status(400).json({ error: '缺少必需字段' });
        }

        const handle = request.body.handle;
        const directories = getUserDirectories(handle);

        let deletedSize = 0;
        let deletedFiles = 0;

        // 只清理备份目录
        if (fs.existsSync(directories.backups)) {
            const backupsSize = await calculateDirectorySize(directories.backups);
            deletedSize += backupsSize;
            const files = await fsPromises.readdir(directories.backups);
            deletedFiles += files.length;
            await fsPromises.rm(directories.backups, { recursive: true, force: true });
            // 重新创建空目录
            await fsPromises.mkdir(directories.backups, { recursive: true });
        }

        console.info(`Cleared backups for user ${handle}: ${deletedFiles} files, ${deletedSize} bytes`);
        return response.json({
            success: true,
            deletedSize: deletedSize,
            deletedFiles: deletedFiles,
            message: `已清理 ${deletedFiles} 个备份文件，释放 ${(deletedSize / 1024 / 1024).toFixed(2)} MB 空间`,
        });
    } catch (error) {
        console.error('Clear backups failed:', error);
        return response.status(500).json({ error: '清理备份文件失败: ' + error.message });
    }
});

/**
 * 一键清理所有用户的备份文件
 */
router.post('/clear-all-backups', requireAdminMiddleware, async (request, response) => {
    try {
        const userHandles = await getAllUserHandles();
        let totalDeletedSize = 0;
        let totalDeletedFiles = 0;
        const results = [];

        for (const handle of userHandles) {
            try {
                const directories = getUserDirectories(handle);
                let userDeletedSize = 0;
                let userDeletedFiles = 0;

                // 只清理备份目录
                if (fs.existsSync(directories.backups)) {
                    const backupsSize = await calculateDirectorySize(directories.backups);
                    userDeletedSize += backupsSize;
                    const files = await fsPromises.readdir(directories.backups);
                    userDeletedFiles += files.length;
                    await fsPromises.rm(directories.backups, { recursive: true, force: true });
                    await fsPromises.mkdir(directories.backups, { recursive: true });
                }

                totalDeletedSize += userDeletedSize;
                totalDeletedFiles += userDeletedFiles;
                results.push({
                    handle: handle,
                    deletedSize: userDeletedSize,
                    deletedFiles: userDeletedFiles,
                });

                console.info(`Cleared backups for user ${handle}: ${userDeletedFiles} files, ${userDeletedSize} bytes`);
            } catch (error) {
                console.error(`Error clearing backups for user ${handle}:`, error);
                results.push({
                    handle: handle,
                    error: error.message,
                });
            }
        }

        console.info(`Cleared all backups: ${totalDeletedFiles} files, ${totalDeletedSize} bytes`);
        return response.json({
            success: true,
            totalDeletedSize: totalDeletedSize,
            totalDeletedFiles: totalDeletedFiles,
            results: results,
            message: `已清理 ${userHandles.length} 个用户的备份文件，共 ${totalDeletedFiles} 个文件，释放 ${(totalDeletedSize / 1024 / 1024).toFixed(2)} MB 空间`,
        });
    } catch (error) {
        console.error('Clear all backups failed:', error);
        return response.status(500).json({ error: '清理所有备份文件失败: ' + error.message });
    }
});

/**
 * 一键删除2个月未登录用户的所有数据
 */
router.post('/delete-inactive-users', requireAdminMiddleware, async (request, response) => {
    try {
        const body = request.body || {};
        const dryRun = body.dryRun === true;

        const inactiveDaysRaw = body.inactiveDays ?? 60;
        const inactiveDays = Math.floor(Number(inactiveDaysRaw));
        if (!Number.isFinite(inactiveDays) || inactiveDays < 1 || inactiveDays > 3650) {
            return response.status(400).json({ error: 'inactiveDays 必须是 1-3650 的整数' });
        }

        const requireUnused = body.requireUnused === true;

        const excludeActiveSubscriptions = body.excludeActiveSubscriptions !== false;

        let maxStorageMB = null;
        if (body.maxStorageMB !== null && body.maxStorageMB !== undefined && String(body.maxStorageMB).trim() !== '') {
            const parsed = Number(body.maxStorageMB);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return response.status(400).json({ error: 'maxStorageMB 必须是 >= 0 的数字' });
            }
            maxStorageMB = parsed;
        }
        const maxStorageBytes = maxStorageMB === null ? null : Math.floor(maxStorageMB * 1024 * 1024);

        const criteria = {
            inactiveDays,
            requireUnused,
            maxStorageMB,
            excludeActiveSubscriptions,
        };

        const inactiveThreshold = inactiveDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        const templateInfo = getDefaultTemplateInfo();
        /** @type {import('../users.js').UserDirectoryList | null} */
        let baselineDirectories = null;
        if (templateInfo.exists && Array.isArray(templateInfo.categories) && templateInfo.categories.length > 0) {
            // IMPORTANT: getUserDirectories() returns a cached object; never mutate it in-place.
            baselineDirectories = { ...getUserDirectories('default-template') };

            const categoryToDirKey = {
                characters: 'characters',
                worlds: 'worlds',
                instruct: 'instruct',
                context: 'context',
                sysprompt: 'sysprompt',
                reasoning: 'reasoning',
                quickreplies: 'quickreplies',
                openai_settings: 'openAI_Settings',
                kobold_settings: 'koboldAI_Settings',
                novel_settings: 'novelAI_Settings',
                textgen_settings: 'textGen_Settings',
            };

            const activeDirKeys = new Set(
                templateInfo.categories
                    .map((categoryId) => categoryToDirKey[categoryId])
                    .filter(Boolean),
            );

            // Only treat active template categories as baseline for "unused" checks.
            for (const key of Object.keys(baselineDirectories)) {
                if (!activeDirKeys.has(key)) {
                    baselineDirectories[key] = null;
                }
            }
        }

        // 获取所有用户
        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        const candidates = [];
        let totalCandidateSize = 0;

        for (const user of users) {
            // 不能删除管理员自己
            if (user.handle === request.user.profile.handle) {
                continue;
            }

            // 不能删除默认用户
            if (user.handle === DEFAULT_USER.handle) {
                continue;
            }

            // 不能删除管理员账户
            if (user.admin) {
                continue;
            }

            const hasActiveSubscription = Boolean(user.expiresAt && user.expiresAt > now);
            if (excludeActiveSubscriptions && hasActiveSubscription) {
                continue;
            }

            // 获取用户的最后活动时间
            const userStats = systemMonitor.getUserLoadStats(user.handle);
            let lastActivityTime = null;

            if (userStats && userStats.lastActivity) {
                // 如果有心跳记录，优先使用心跳时间
                if (userStats.lastHeartbeat) {
                    lastActivityTime = userStats.lastHeartbeat;
                } else {
                    lastActivityTime = userStats.lastActivity;
                }
            } else {
                // 如果没有活动记录，使用用户创建时间作为最后活动时间
                lastActivityTime = user.created || 0;
            }

            const timeSinceLastActivity = now - lastActivityTime;
            if (!(timeSinceLastActivity > inactiveThreshold)) {
                continue;
            }

            const daysSinceLastActivity = Math.floor(timeSinceLastActivity / (24 * 60 * 60 * 1000));
            const hasBoundEmail = typeof user.email === 'string' && user.email.trim().length > 0;

            const directories = getUserDirectories(user.handle);
            const storageSize = await calculateDirectorySize(directories.root);

            if (maxStorageBytes !== null && storageSize > maxStorageBytes) {
                continue;
            }

            let unusedCheck = null;
            if (requireUnused) {
                unusedCheck = await checkUserIsUnused(directories, baselineDirectories);
                if (!unusedCheck.isUnused) {
                    continue;
                }
            }

            candidates.push({
                handle: user.handle,
                name: user.name,
                lastActivity: lastActivityTime,
                lastActivityFormatted: new Date(lastActivityTime).toLocaleString('zh-CN'),
                daysSinceLastActivity,
                storageSize,
                hasEmail: hasBoundEmail,
                expiresAt: user.expiresAt || null,
                hasActiveSubscription,
                isUnused: unusedCheck ? unusedCheck.isUnused : null,
            });
            totalCandidateSize += storageSize;
        }

        const previewId = crypto
            .createHash('sha256')
            .update(JSON.stringify({ criteria, handles: candidates.map((u) => u.handle).sort() }))
            .digest('hex');

        if (dryRun) {
            return response.json({
                success: true,
                dryRun: true,
                criteria,
                previewId,
                inactiveUsers: candidates,
                totalUsers: candidates.length,
                totalSize: totalCandidateSize,
                message: `发现 ${candidates.length} 个用户超过 ${inactiveDays} 天未登录`,
            });
        }

        // 实际删除模式：需要二次确认参数，避免误触
        const requestPreviewId = body.previewId;
        const confirmCountRaw = body.confirmCount;
        const confirmCount = Number(confirmCountRaw);

        if (typeof requestPreviewId !== 'string' || requestPreviewId.length < 8) {
            return response.status(400).json({ error: '缺少 previewId，请先进行预览扫描' });
        }

        if (!Number.isFinite(confirmCount) || !Number.isInteger(confirmCount) || confirmCount < 0) {
            return response.status(400).json({ error: '缺少 confirmCount，请输入本次将删除的用户数量' });
        }

        if (requestPreviewId !== previewId) {
            return response.status(409).json({ error: '预览结果已变化，请重新扫描后再删除' });
        }

        if (confirmCount !== candidates.length) {
            return response.status(400).json({ error: `confirmCount 不匹配：当前将删除 ${candidates.length} 个用户` });
        }

        const results = [];
        let totalDeletedSize = 0;

        for (const candidate of candidates) {
            let emailNotified = false;
            let emailError = null;

            try {
                const user = await storage.getItem(toKey(candidate.handle));
                if (!user) {
                    results.push({
                        handle: candidate.handle,
                        name: candidate.name,
                        success: false,
                        error: 'User not found',
                    });
                    continue;
                }

                // 再次确认关键保护规则（防止 race / 误删）
                if (candidate.handle === request.user.profile.handle || candidate.handle === DEFAULT_USER.handle || user.admin) {
                    results.push({
                        handle: candidate.handle,
                        name: candidate.name,
                        success: false,
                        error: 'Protected user cannot be deleted',
                    });
                    continue;
                }

                if (excludeActiveSubscriptions && user.expiresAt && user.expiresAt > Date.now()) {
                    results.push({
                        handle: candidate.handle,
                        name: candidate.name,
                        success: false,
                        error: 'User has active subscription',
                    });
                    continue;
                }

                const hasBoundEmail = typeof user.email === 'string' && user.email.trim().length > 0;
                if (hasBoundEmail) {
                    if (isEmailServiceAvailable()) {
                        const sent = await sendInactiveUserDeletionNotice(
                            user.email.trim(),
                            user.name,
                            candidate.daysSinceLastActivity,
                        );
                        emailNotified = sent;
                        if (!sent) {
                            emailError = 'Failed to send notification email';
                        }
                    } else {
                        emailError = 'Email service not available';
                    }
                }

                const directories = getUserDirectories(candidate.handle);

                // 删除用户记录
                await storage.removeItem(toKey(candidate.handle));
                await storage.removeItem(toAvatarKey(candidate.handle));

                // 删除用户数据目录
                if (fs.existsSync(directories.root)) {
                    await fsPromises.rm(directories.root, { recursive: true, force: true });
                }

                // 重置用户统计数据
                systemMonitor.resetUserStats(candidate.handle);

                totalDeletedSize += candidate.storageSize;
                results.push({
                    handle: candidate.handle,
                    name: candidate.name,
                    success: true,
                    deletedSize: candidate.storageSize,
                    emailNotified,
                    emailError,
                    message: `已删除用户 ${candidate.handle}，释放 ${(candidate.storageSize / 1024 / 1024).toFixed(2)} MB 空间`,
                });

                console.info(`Deleted inactive user ${candidate.handle}: ${(candidate.storageSize / 1024 / 1024).toFixed(2)} MB`);
            } catch (error) {
                console.error(`Error deleting user ${candidate.handle}:`, error);
                results.push({
                    handle: candidate.handle,
                    name: candidate.name,
                    success: false,
                    error: error.message,
                    emailNotified,
                    emailError,
                });
            }
        }

        return response.json({
            success: true,
            dryRun: false,
            criteria,
            previewId,
            deletedUsers: results.filter(r => r.success),
            failedUsers: results.filter(r => !r.success),
            totalDeleted: results.filter(r => r.success).length,
            totalFailed: results.filter(r => !r.success).length,
            totalDeletedSize,
            message: `已删除 ${results.filter(r => r.success).length} 个用户，释放 ${(totalDeletedSize / 1024 / 1024).toFixed(2)} MB 空间`,
        });
    } catch (error) {
        console.error('Delete inactive users failed:', error);
        return response.status(500).json({ error: '删除不活跃用户失败: ' + error.message });
    }
});
