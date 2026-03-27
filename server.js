/*
  IGNITE Party Game — Multiplayer Room Server
  Stack: Node.js + Express + Socket.io
  Deploy to: Railway / Render / Fly.io (free tier works fine)
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // In production, set to your Netlify URL e.g. "https://truthordarewithfrndss.netlify.app"
    methods: ["GET", "POST"],
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ── In-memory room store ──────────────────────────────────────────────────────
const rooms = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getPublicRoom(room) {
  // Strip internal ids from player objects for safety
  return {
    ...room,
    players: room.players.map((p) => ({
      name: p.name,
      emoji: p.emoji,
      isHost: p.isHost,
      eliminated: p.eliminated || false,
      stats: p.stats,
      socketId: p.socketId, // needed by clients to know "which slot am I"
    })),
  };
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit("room-update", getPublicRoom(room));
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── CREATE ROOM ────────────────────────────────────────────────────────────
  socket.on("create-room", ({ playerName, emoji, difficulty, gameMode }) => {
    if (!playerName || playerName.trim().length === 0) {
      return socket.emit("error", { message: "Player name is required." });
    }

    let roomId;
    let tries = 0;
    do {
      roomId = generateRoomId();
      tries++;
    } while (rooms.has(roomId) && tries < 100);

    const room = {
      id: roomId,
      hostSocketId: socket.id,
      players: [
        {
          socketId: socket.id,
          name: playerName.trim().substring(0, 16),
          emoji: emoji || "😄",
          isHost: true,
          eliminated: false,
          stats: { truth: 0, dare: 0, skip: 0 },
        },
      ],
      settings: {
        difficulty: difficulty || "medium",
        gameMode: gameMode || "tod",
      },
      gameState: {
        phase: "lobby", // lobby | playing | spinning | choice | task | ended
        round: 1,
        currentPlayer: null,
        currentTask: null,
        spinning: false,
      },
      chat: [],
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName.trim();

    socket.emit("room-created", { roomId, room: getPublicRoom(room) });
    console.log(`[ROOM] Created ${roomId} by ${playerName}`);
  });

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  socket.on("join-room", ({ roomId, playerName, emoji }) => {
    const id = (roomId || "").toUpperCase().trim();
    const room = rooms.get(id);

    if (!room)
      return socket.emit("error", {
        message: "Room not found. Check the code and try again.",
      });
    if (room.players.length >= 8)
      return socket.emit("error", { message: "Room is full! Max 8 players." });
    if (room.gameState.phase !== "lobby")
      return socket.emit("error", {
        message: "Game has already started. Wait for the next round!",
      });
    if (!playerName || playerName.trim().length === 0)
      return socket.emit("error", { message: "Player name is required." });

    const cleanName = playerName.trim().substring(0, 16);
    if (
      room.players.find((p) => p.name.toLowerCase() === cleanName.toLowerCase())
    ) {
      return socket.emit("error", {
        message: `"${cleanName}" is already taken in this room. Choose another name.`,
      });
    }

    room.players.push({
      socketId: socket.id,
      name: cleanName,
      emoji: emoji || "😄",
      isHost: false,
      eliminated: false,
      stats: { truth: 0, dare: 0, skip: 0 },
    });

    socket.join(id);
    socket.data.roomId = id;
    socket.data.playerName = cleanName;

    socket.emit("room-joined", { roomId: id, room: getPublicRoom(room) });
    io.to(id).emit("player-joined", {
      playerName: cleanName,
      emoji: emoji || "😄",
    });
    broadcastRoom(id);
    console.log(`[ROOM] ${cleanName} joined ${id}`);
  });

  // ── UPDATE SETTINGS (host only) ────────────────────────────────────────────
  socket.on("update-settings", ({ difficulty, gameMode }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    room.settings.difficulty = difficulty || room.settings.difficulty;
    room.settings.gameMode = gameMode || room.settings.gameMode;
    broadcastRoom(socket.data.roomId);
  });

  // ── START GAME (host only) ─────────────────────────────────────────────────
  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.players.length < 2)
      return socket.emit("error", {
        message: "Need at least 2 players to start.",
      });

    room.gameState.phase = "playing";
    room.gameState.round = 1;
    broadcastRoom(socket.data.roomId);
    io.to(socket.data.roomId).emit("game-started", { settings: room.settings });
    console.log(`[ROOM] Game started in ${socket.data.roomId}`);
  });

  // ── END GAME & SHOW SUMMARY (host only) ────────────────────────────────────
  socket.on("end-game", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    // Reset phase to lobby and tell all clients to show the summary
    room.gameState.phase = "lobby";
    room.gameState.round = 1;
    room.gameState.currentPlayer = null;
    room.gameState.currentTask = null;
    room.gameState.spinning = false;

    // Reset stats for next game
    room.players.forEach((p) => {
      p.stats = { truth: 0, dare: 0, skip: 0 };
      p.eliminated = false;
    });

    broadcastRoom(roomId);
    io.to(roomId).emit("game-ended");
  });

  // ── SPIN (anyone can spin on their turn; host can always spin) ─────────────
  socket.on("spin", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.gameState.phase !== "playing") return;
    if (room.gameState.spinning) return;

    room.gameState.spinning = true;
    room.gameState.phase = "spinning";

    const activePlayers = room.players.filter((p) => !p.eliminated);
    if (activePlayers.length === 0) return;

    const picked =
      activePlayers[Math.floor(Math.random() * activePlayers.length)];
    room.gameState.currentPlayer = picked.name;
    room.gameState.currentPlayerId = picked.socketId;

    broadcastRoom(roomId);
    io.to(roomId).emit("spin-started", { targetPlayer: picked.name });

    // Reveal after 2.8s (matches frontend animation duration)
    setTimeout(() => {
      room.gameState.spinning = false;
      room.gameState.phase = "choice";
      broadcastRoom(roomId);
      io.to(roomId).emit("spin-result", {
        player: picked.name,
        playerId: picked.socketId,
        round: room.gameState.round,
      });
    }, 2800);
  });

  // ── PICK TASK (the picked player or host picks truth/dare) ─────────────────
  socket.on("pick-task", ({ type, questionText }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.gameState.phase !== "choice") return;

    // Only the current player or host can pick
    const isCurrentPlayer =
      socket.data.playerName === room.gameState.currentPlayer;
    const isHost = room.hostSocketId === socket.id;
    if (!isCurrentPlayer && !isHost) return;

    room.gameState.currentTask = { type, text: questionText };
    room.gameState.phase = "task";
    broadcastRoom(roomId);
    io.to(roomId).emit("task-assigned", {
      type,
      text: questionText,
      player: room.gameState.currentPlayer,
      playerId: room.gameState.currentPlayerId,
    });
  });

  // ── NEW QUESTION (skip to new question, same type) ─────────────────────────
  socket.on("new-question", ({ type, questionText }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.gameState.phase !== "task") return;
    const isCurrentPlayer =
      socket.data.playerName === room.gameState.currentPlayer;
    const isHost = room.hostSocketId === socket.id;
    if (!isCurrentPlayer && !isHost) return;

    room.gameState.currentTask = { type, text: questionText };
    broadcastRoom(roomId);
    io.to(roomId).emit("task-assigned", {
      type,
      text: questionText,
      player: room.gameState.currentPlayer,
      playerId: room.gameState.currentPlayerId,
    });
  });

  // ── COMPLETE TASK ──────────────────────────────────────────────────────────
  socket.on("complete-task", ({ type }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.gameState.phase !== "task") return;
    const isCurrentPlayer =
      socket.data.playerName === room.gameState.currentPlayer;
    const isHost = room.hostSocketId === socket.id;
    if (!isCurrentPlayer && !isHost) return;

    const player = room.players.find(
      (p) => p.name === room.gameState.currentPlayer,
    );
    if (player) player.stats[type] = (player.stats[type] || 0) + 1;

    room.gameState.round++;
    room.gameState.phase = "playing";
    room.gameState.currentTask = null;
    room.gameState.currentPlayer = null;
    room.gameState.currentPlayerId = null;

    broadcastRoom(roomId);
    io.to(roomId).emit("task-completed", { type, round: room.gameState.round });
  });

  // ── CHAT ──────────────────────────────────────────────────────────────────
  socket.on("chat-message", ({ message }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !message || !message.trim()) return;

    const msg = {
      id: Date.now() + Math.random(),
      player: socket.data.playerName,
      message: message.trim().substring(0, 200),
      ts: Date.now(),
    };

    room.chat.push(msg);
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);

    io.to(roomId).emit("chat-message", msg);
  });

  // ── REACTION ─────────────────────────────────────────────────────────────
  socket.on("reaction", ({ emoji }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit("reaction", {
      player: socket.data.playerName,
      emoji,
      id: Date.now() + Math.random(),
    });
  });

  // ── KICK PLAYER (host only) ───────────────────────────────────────────────
  socket.on("kick-player", ({ playerName }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    const target = room.players.find((p) => p.name === playerName && !p.isHost);
    if (!target) return;

    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit("kicked", {
        message: "You were removed from the room by the host.",
      });
      targetSocket.leave(roomId);
      targetSocket.data.roomId = null;
    }

    room.players = room.players.filter((p) => p.name !== playerName);
    io.to(roomId).emit("player-left", { playerName });
    broadcastRoom(roomId);
  });

  // ── NEVER HAVE I EVER: admit ──────────────────────────────────────────────
  socket.on("nihhi-admit", ({ admitted, round }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    io.to(roomId).emit("nihhi-admit", {
      player: socket.data.playerName,
      admitted,
      round,
    });
  });

  socket.on("nihhi-next", ({ questionText, round }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;
    io.to(roomId).emit("nihhi-question", { text: questionText, round });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const playerName = socket.data.playerName;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const wasHost = room.hostSocketId === socket.id;
    room.players = room.players.filter((p) => p.socketId !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(roomId);
      console.log(`[ROOM] ${roomId} deleted (empty)`);
      return;
    }

    if (wasHost && room.players.length > 0) {
      // Transfer host
      room.players[0].isHost = true;
      room.hostSocketId = room.players[0].socketId;
      io.to(roomId).emit("host-changed", { newHost: room.players[0].name });
    }

    io.to(roomId).emit("player-left", { playerName });
    broadcastRoom(roomId);
    console.log(`[-] ${playerName} left ${roomId}`);
  });
});

// ── REST endpoints ────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({ status: "IGNITE server running 🔥", rooms: rooms.size }),
);
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    rooms: rooms.size,
    players: [...rooms.values()].reduce((a, r) => a + r.players.length, 0),
  }),
);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🔥 IGNITE multiplayer server running on port ${PORT}`);
});
