require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// הגדרות שרת בסיסיות
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_for_topo_game';

// ==========================================
// 1. חיבור למסד הנתונים (MongoDB)
// ==========================================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/topogame')
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch(err => console.error('MongoDB connection error:', err));

// סכמת משתמש בסיסית לצורך שמירה בענן
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    coins: { type: Number, default: 0 },
    xp: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// ==========================================
// 2. נתיבי אותנטיקציה (Authentication Routes)
// ==========================================

// א) כניסת אורח אנונימי (ללא שמירה)
app.post('/api/auth/guest', (req, res) => {
    const guestId = Math.floor(1000 + Math.random() * 9000);
    const guestUsername = `Guest_${guestId}`;
    
    // הנפקת טוקן זמני המסומן כ-isGuest
    const token = jwt.sign(
        { id: `guest_${guestId}`, username: guestUsername, isGuest: true },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
    
    res.json({
        token,
        username: guestUsername,
        gameData: { coins: 0, xp: 0 }
    });
});

// ב) הרשמת משתמש חדש
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const newUser = new User({ username, email, password: hashedPassword });
        await newUser.save();
        
        res.status(201).json({ message: "Account created successfully!" });
    } catch (err) {
        res.status(400).json({ message: "Username or Email already exists." });
    }
});

// ג) התחברות משתמש רשום
app.post('/api/auth/login', async (req, res) => {
    try {
        const { identifier, password } = req.body; // identifier יכול להיות מייל או שם משתמש
        const user = await User.findOne({
            $or: [{ username: identifier }, { email: identifier }]
        });
        
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: "Invalid credentials." });
        }
        
        const token = jwt.sign(
            { id: user._id, username: user.username, isGuest: false },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            token,
            username: user.username,
            gameData: { coins: user.coins, xp: user.xp }
        });
    } catch (err) {
        res.status(500).json({ message: "Internal server error." });
    }
});


// ==========================================
// 3. ניהול חדרים ומשחקים (Game State)
// ==========================================
const rooms = {}; // מבנה נתונים שמחזיק את כל החדרים הפעילים

// פונקציית עזר ליצירת קוד חדר רנדומלי בן 6 אותיות
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// לולאת המשחק המרכזית - רצה ב-20Hz (כל 50 מילישניות) ומסנכרנת את כולם
setInterval(() => {
    for (const roomCode in rooms) {
        const room = rooms[roomCode];
        if (room.isActive) {
            // כאן אפשר להוסיף לוגיקת שרת כמו תנועת אוכל או בדיקת התנגשויות
            io.to(roomCode).emit('gameStateUpdate', { players: room.players });
        }
    }
}, 50);


// ==========================================
// 4. תקשורת מולטיפלייר בזמן אמת (Socket.IO)
// ==========================================

// Middleware לאימות הטוקן של ה-Socket לפני חיבור
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error"));

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Authentication error"));
        socket.userData = decoded; // שמירת המידע של השחקן בתוך הסוקט
        next();
    });
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.userData.username} (${socket.userData.isGuest ? 'Guest' : 'Registered'})`);
    let currentRoomCode = null;

    // א) יצירת חדר פרטי חדש
    socket.on('createRoom', () => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            owner: socket.id,
            players: {},
            maxCapacity: 8,
            isActive: false
        };
        
        joinPlayerToRoom(socket, roomCode);
    });

    // ב) כניסה לחדר קיים באמצעות קוד
    socket.on('joinRoom', (roomCode) => {
        const code = roomCode.toUpperCase();
        const room = rooms[code];
        
        if (!room) {
            return socket.emit('errorMsg', 'Room not found.');
        }
        if (Object.keys(room.players).length >= room.maxCapacity) {
            return socket.emit('errorMsg', 'Room is full.');
        }
        if (room.isActive) {
            return socket.emit('errorMsg', 'Match already in progress.');
        }

        joinPlayerToRoom(socket, code);
    });

    // ג) עדכון קלט/מיקום מהלקוח
    socket.on('playerInput', (inputData) => {
        if (currentRoomCode && rooms[currentRoomCode]) {
            const player = rooms[currentRoomCode].players[socket.id];
            if (player) {
                // עדכון זמני של מיקום השחקן בשרת (כאן אפשר להוסיף הגנות אנטי-צ'יט)
                player.x = inputData.x;
                player.y = inputData.y;
            }
        }
    });

    // ד) צ'אט בתוך הלובי
    socket.on('sendChatMessage', (message) => {
        if (currentRoomCode) {
            io.to(currentRoomCode).emit('chatMessage', {
                username: socket.userData.username,
                text: message
            });
        }
    });

    // ה) עזיבת חדר או התנתקות
    socket.on('leaveRoom', () => {
        handleRoomLeave(socket);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.userData.username}`);
        handleRoomLeave(socket);
    });

    // פונקציות עזר פנימיות לניהול סוקטים
    function joinPlayerToRoom(sk, code) {
        currentRoomCode = code;
        sk.join(code);
        
        rooms[code].players[sk.id] = {
            id: sk.id,
            username: sk.userData.username,
            x: 960, // מיקום התחלתי במרכז קנבס full HD
            y: 540,
            isGuest: sk.userData.isGuest
        };

        // עדכון כל החדר על השחקן החדש
        io.to(code).emit('roomUpdated', {
            code: code,
            owner: rooms[code].owner,
            players: Object.values(rooms[code].players)
        });
    }

    function handleRoomLeave(sk) {
        if (currentRoomCode && rooms[currentRoomCode]) {
            const room = rooms[currentRoomCode];
            delete room.players[sk.id];
            sk.leave(currentRoomCode);

            // אם החדר ריק, נמחק אותו מהזיכרון
            if (Object.keys(room.players).length === 0) {
                delete rooms[currentRoomCode];
            } else {
                // אם בעל החדר עזב, נעביר את הניהול לבא בתור
                if (room.owner === sk.id) {
                    room.owner = Object.keys(room.players)[0];
                }
                
                io.to(currentRoomCode).emit('roomUpdated', {
                    code: currentRoomCode,
                    owner: room.owner,
                    players: Object.values(room.players)
                });
            }
            currentRoomCode = null;
        }
    }
});

// ==========================================
// 5. פונקציית שמירת ניקוד בסיום משחק
// ==========================================
function saveMatchResultsToDatabase(userId, earnedCoins, earnedXp) {
    // הגנה חיונית: אם זה שחקן אנונימי (אורח), לא נוגעים בבסיס הנתונים
    if (userId.startsWith('guest_')) {
        console.log(`Guest account ${userId} finished match. Data omitted from Database.`);
        return;
    }

    // שחקן רשום - עדכון רשמי של הנתונים בענן
    User.findByIdAndUpdate(
        userId,
        { $inc: { coins: earnedCoins, xp: earnedXp } },
        { new: true }
    ).then(updatedUser => {
        console.log(`Saved progress for registered user: ${updatedUser.username}`);
    }).catch(err => {
        console.error("Failed to save match results:", err);
    });
}

// הפעלת השרת
server.listen(PORT, () => {
    console.log(`TOPO GAME Server is running on http://localhost:${PORT}`);
});
