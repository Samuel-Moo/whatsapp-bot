const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth()
});

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

function logIncomingMessage(message) {
    console.log(`[IN] from=${message.from} body="${message.body}"`);
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

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on("message", async (message) => {
    const text = message.body.trim();
    const lowerText = text.toLowerCase();
    logIncomingMessage(message);

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
        const [, query = 'pikachu'] = text.split(/\s+/, 2);
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
client.initialize();
