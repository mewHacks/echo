// Mock Discord client for testing
// Simulates Discord.js client behavior

const { PermissionsBitField, ChannelType } = require('discord.js');

// Mock channel
const createMockChannel = (id, name, type = ChannelType.GuildText, canSend = true) => ({
    id,
    name,
    type,
    send: jest.fn().mockResolvedValue({ id: 'mock-message-id' }),
    permissionsFor: jest.fn().mockReturnValue({
        has: jest.fn().mockReturnValue(canSend),
    }),
});

// Mock guild member
const createMockMember = (id, username, permissions = []) => ({
    id,
    user: {
        id,
        tag: `${username}#0000`,
        username,
        bot: false,
    },
    permissions: {
        has: (flag) => permissions.includes(flag),
    },
    send: jest.fn().mockResolvedValue({ id: 'mock-dm-id' }),
});

// Mock guild
const createMockGuild = (id, name, channels = [], members = []) => {
    const channelCache = new Map();
    channels.forEach(ch => channelCache.set(ch.id, ch));

    const memberCache = new Map();
    members.forEach(m => memberCache.set(m.id, m));

    return {
        id,
        name,
        channels: {
            cache: {
                get: (cid) => channelCache.get(cid),
                find: (fn) => [...channelCache.values()].find(fn),
                filter: (fn) => new Map([...channelCache.entries()].filter(([k, v]) => fn(v))),
            },
        },
        members: {
            cache: {
                get: (mid) => memberCache.get(mid),
                filter: (fn) => new Map([...memberCache.entries()].filter(([k, v]) => fn(v))),
            },
            me: {
                id: 'bot-id',
                permissions: {
                    has: jest.fn().mockReturnValue(true),
                },
            },
            fetch: jest.fn().mockResolvedValue(memberCache),
        },
    };
};

// Mock client
let mockGuilds = new Map();
let clientReady = true;

const mockClient = {
    guilds: {
        cache: {
            get: (guildId) => mockGuilds.get(guildId),
        },
    },
    user: {
        id: 'bot-id',
        tag: 'Echo#0000',
    },
};

function getDiscordClient() {
    return mockClient;
}

function isClientReady() {
    return clientReady;
}

// Test helpers
function setClientReady(ready) {
    clientReady = ready;
}

function addMockGuild(guild) {
    mockGuilds.set(guild.id, guild);
}

function clearMockGuilds() {
    mockGuilds.clear();
}

function resetMocks() {
    mockGuilds.clear();
    clientReady = true;
}

module.exports = {
    getDiscordClient,
    isClientReady,
    setClientReady,
    addMockGuild,
    clearMockGuilds,
    resetMocks,
    createMockChannel,
    createMockMember,
    createMockGuild,
};
