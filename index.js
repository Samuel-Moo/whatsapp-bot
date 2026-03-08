const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const client = new Client({
    authStrategy: new LocalAuth()
});

const AUTH_STORE_PATH = path.join(__dirname, 'auth-store.json');
const HASH_ITERATIONS = 120000;
const HASH_KEY_LEN = 64;
const HASH_DIGEST = 'sha512';

let authStore = {
    users: {},
    sessions: {}
};
let saveStoreChain = Promise.resolve();

async function ensureAuthStore() {
    try {
        const raw = await fs.readFile(AUTH_STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        authStore = {
            users: parsed?.users || {},
            sessions: parsed?.sessions || {}
        };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        await persistAuthStore();
    }
}

function persistAuthStore() {
    saveStoreChain = saveStoreChain.then(() =>
        fs.writeFile(AUTH_STORE_PATH, JSON.stringify(authStore, null, 2), 'utf8')
    );
    return saveStoreChain;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto
        .pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEY_LEN, HASH_DIGEST)
        .toString('hex');

    return {
        salt,
        hash,
        iterations: HASH_ITERATIONS,
        keyLength: HASH_KEY_LEN,
        digest: HASH_DIGEST
    };
}

function verifyPassword(password, passwordRecord) {
    const computedHash = crypto
        .pbkdf2Sync(
            password,
            passwordRecord.salt,
            passwordRecord.iterations,
            passwordRecord.keyLength,
            passwordRecord.digest
        )
        .toString('hex');

    return crypto.timingSafeEqual(
        Buffer.from(computedHash, 'hex'),
        Buffer.from(passwordRecord.hash, 'hex')
    );
}

function caesarCipher(text, shift) {
    let cipher = '';

    for (const character of text) {
        if (/[a-zA-Z]/.test(character)) {
            const shiftMod = shift % 26;
            const base = character >= 'a' && character <= 'z' ? 'a'.charCodeAt(0) : 'A'.charCodeAt(0);
            const shiftedChar = String.fromCharCode((character.charCodeAt(0) - base + shiftMod + 26) % 26 + base);
            cipher += shiftedChar;
        } else {
            cipher += character;
        }
    }

    return cipher;
}

function decipher(text, shift) {
    let deciphered = '';

    for (const character of text) {
        if (/[a-zA-Z]/.test(character)) {
            const shiftMod = shift % 26;
            const base = character >= 'a' && character <= 'z' ? 'a'.charCodeAt(0) : 'A'.charCodeAt(0);
            const shiftedChar = String.fromCharCode((character.charCodeAt(0) - base - shiftMod + 26) % 26 + base);
            deciphered += shiftedChar;
        } else {
            deciphered += character;
        }
    }

    return deciphered;
}

function getSenderPhoneNumber(message) {
    const senderId = message.author || message.from || '';
    const [phoneNumber] = senderId.split('@');
    return phoneNumber || null;
}

function logIncomingMessage(message) {
    const phoneNumber = getSenderPhoneNumber(message);
    console.log(`[IN] from=${message.from} number=${phoneNumber || 'unknown'} body="${message.body}"`);
}

async function replyWithLog(message, text) {
    console.log(`[OUT][reply] to=${message.from} body="${text}"`);
    return message.reply(text);
}

async function sendMessageWithLog(to, content, options = {}) {
    const contentPreview = typeof content === 'string' ? content : '[media]';
    const stickerInfo = options.sendMediaAsSticker ? ` stickerName=${options.stickerName || 'unknown'}` : '';
    console.log(`[OUT][sendMessage] to=${to} body="${contentPreview}"${stickerInfo}`);
    return client.sendMessage(to, content, options);
}

async function isCommunityChatMessage(message) {
    try {
        const chat = await message.getChat();
        if (!chat?.isGroup) {
            return false;
        }

        const metadata = chat.groupMetadata || {};
        const hasParentCommunity =
            !!chat.parentGroupId ||
            !!metadata.parentGroupId ||
            !!metadata.linkedParent;
        const isCommunityContainer =
            !!chat.isCommunity ||
            !!metadata.isCommunity ||
            !!metadata.isParentGroup ||
            !!metadata.community;

        return hasParentCommunity || isCommunityContainer;
    } catch (error) {
        console.error('Error checking community chat:', error);
        return false;
    }
}

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on("message", async (message) => {
    if (await isCommunityChatMessage(message)) {
        console.log(`[SKIP] Community chat message ignored from=${message.from}`);
        return;
    }

    const text = message.body.trim();
    const lowerText = text.toLowerCase();
    const phoneNumber = getSenderPhoneNumber(message);
    const [command = ''] = lowerText.split(/\s+/, 1);
    const isUserLoggedIn = !!authStore.sessions[phoneNumber]?.loggedIn;
    logIncomingMessage(message);

    if (!phoneNumber) {
        await replyWithLog(message, 'Unable to identify your phone number.');
        return;
    }

    if (command === '!register') {
        const [, password] = text.split(/\s+/, 2);

        if (!password) {
            await replyWithLog(message, 'Usage: !register <password>');
            return;
        }

        if (authStore.users[phoneNumber]) {
            await replyWithLog(message, 'You are already registered. Use !login <password>.');
            return;
        }

        authStore.users[phoneNumber] = {
            phoneNumber,
            password: hashPassword(password),
            createdAt: new Date().toISOString()
        };

        await persistAuthStore();
        await replyWithLog(message, 'Registration complete. Use !login <password>.');
        return;
    }

    if (command === '!login') {
        const [, password] = text.split(/\s+/, 2);

        if (!password) {
            await replyWithLog(message, 'Usage: !login <password>');
            return;
        }

        const user = authStore.users[phoneNumber];
        if (!user) {
            await replyWithLog(message, 'Connection error: user not registered. Use !register <password>.');
            return;
        }

        const isPasswordValid = verifyPassword(password, user.password);
        if (!isPasswordValid) {
            await replyWithLog(message, 'Connection error: invalid credentials.');
            return;
        }

        authStore.sessions[phoneNumber] = {
            loggedIn: true,
            loginAt: new Date().toISOString()
        };

        await persistAuthStore();
        await replyWithLog(message, 'Login successful. Session is active.');
        return;
    }

    if (command === '!logout') {
        if (authStore.sessions[phoneNumber]?.loggedIn) {
            authStore.sessions[phoneNumber] = {
                loggedIn: false,
                loginAt: null,
                logoutAt: new Date().toISOString()
            };
            await persistAuthStore();
        }

        await replyWithLog(message, 'Session closed.');
        return;
    }

    if (command === '!session') {
        await replyWithLog(
            message,
            isUserLoggedIn
                ? `Logged in as ${phoneNumber}.`
                : 'No active session. Use !login <password>.'
        );
        return;
    }

    const isBotCommand =
        lowerText === 'ping' ||
        lowerText === 'que' ||
        lowerText.startsWith('!pokemon') ||
        lowerText.startsWith('!cypher') ||
        lowerText.startsWith('!decypher');

    if (isBotCommand && !isUserLoggedIn) {
        await replyWithLog(message, 'Please login first with !login <password>.');
        return;
    }

    if (lowerText === 'ping') {
        await replyWithLog(message, 'pong');
    } else if (lowerText === 'que') {
        const url = 
            "https://images7.memedroid.com/images/UPLOADED574/625f4dd6290b4.jpeg";
        try { 
            const media = await MessageMedia.fromUrl(url);
            await sendMessageWithLog(message.from, media, {
                sendMediaAsSticker: true,
                stickerAuthor: "yo",
                stickerName: "sticker"
            });
        } catch (error) {
            console.error('Error sending sticker:', error);
        }
    } else if (lowerText.startsWith('!pokemon')) {
        const [, query = 'random'] = text.split(/\s+/, 2);
        let pokemonNameOrId = query.toLowerCase();

        try {
            if (pokemonNameOrId === 'random') {
                const countResponse = await fetch('https://pokeapi.co/api/v2/pokemon?limit=1');
                if (!countResponse.ok) {
                    throw new Error(`PokeAPI count request failed with status ${countResponse.status}`);
                }

                const countData = await countResponse.json();
                pokemonNameOrId = String(Math.floor(Math.random() * countData.count) + 1);
            }

            const url = `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(pokemonNameOrId)}/`;
            const response = await fetch(url);
            if (!response.ok) {
                await replyWithLog(message, `Pokemon "${pokemonNameOrId}" not found.`);
                return;
            }

            const data = await response.json();
            const pokemonSprite =
                data.sprites?.other?.showdown?.front_default ||
                data.sprites?.front_default;

            if (!pokemonSprite) {
                await replyWithLog(message, `No usable sprite found for ${data.name}.`);
                return;
            }

            const media = await MessageMedia.fromUrl(pokemonSprite);

            await sendMessageWithLog(message.from, media, {
                sendMediaAsSticker: true,
                stickerAuthor: "yo",
                stickerName: data.name
            });
        } catch (error) {
            console.error('Error sending sticker:', error);
        }
    } else if (lowerText.startsWith('!cypher')) {
        const [, word, shiftStr] = text.split(/\s+/, 3);
        const shift = parseInt(shiftStr, 10);

        if (!word || isNaN(shift)) {
            await replyWithLog(message, 'Usage: !cypher <text> <shift>');
            return;
        }

        const ciphered = caesarCipher(word, shift);
        await replyWithLog(message, ciphered);
    } else if (lowerText.startsWith('!decypher')) {
        const [, word, shiftStr] = text.split(/\s+/, 3);
        const shift = parseInt(shiftStr, 10);
        
        if (!word || isNaN(shift)) {
            await replyWithLog(message, 'Usage: !decypher <text> <shift>');
            return;
        }

        const deciphered = decipher(word, shift);
        await replyWithLog(message, deciphered);
}
}); 
ensureAuthStore()
    .then(() => client.initialize())
    .catch((error) => {
        console.error('Failed to initialize auth storage:', error);
        process.exit(1);
    });
