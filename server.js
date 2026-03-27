/*
  =========================================================
  IGNITE Party Game — Multiplayer Room Server
  Stack: Node.js + Express + Socket.io
  =========================================================
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: "*", // Set to your Netlify URL in production for better security
    methods: ["GET", "POST"],
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ── IN-MEMORY DATABASE ────────────────────────────────────────────────────────
// In a real large-scale app you'd use Redis/Database, but a Map is perfect here.
const rooms = new Map();

// ── HELPER FUNCTIONS ──────────────────────────────────────────────────────────
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function getPublicRoom(room) {
  // Strip internal/private data before sending state to all clients
  return {
    ...room,
    players: room.players.map((p) => ({
      name: p.name,
      emoji: p.emoji,
      isHost: p.isHost,
      eliminated: p.eliminated || false,
      offline: p.offline || false, // Track if they disconnected
      stats: p.stats,
      socketId: p.socketId, // Sent so clients know who they are
    })),
  };
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    io.to(roomId).emit("room-update", getPublicRoom(room));
  }
}

// ── SOCKET EVENT LISTENERS ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[CONNECTION] New client connected: ${socket.id}`);

  // ── 1. CREATE ROOM ──────────────────────────────────────────────────────────
  socket.on("create-room", ({ playerName, emoji, difficulty, gameMode }) => {
    if (!playerName || playerName.trim().length === 0) {
      return socket.emit("error", { message: "Player name is required." });
    }

    let roomId;
    let tries = 0;
    // Ensure we don't accidentally overwrite an existing room
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
          offline: false, // New offline tracking
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

    // Save to socket data for quick access on disconnect
    socket.data.roomId = roomId;
    socket.data.playerName = playerName.trim();

    socket.emit("room-created", { roomId, room: getPublicRoom(room) });
    console.log(`[CREATE] Room ${roomId} created by ${playerName.trim()}`);
  });

  // ── 2. JOIN ROOM & RECONNECT LOGIC ──────────────────────────────────────────
  socket.on("join-room", ({ roomId, playerName, emoji }) => {
    const id = (roomId || "").toUpperCase().trim();
    const room = rooms.get(id);

    if (!room) {
      return socket.emit("error", {
        message: "Room not found. Check the code.",
      });
    }

    const cleanName = playerName.trim().substring(0, 16);
    if (!cleanName) {
      return socket.emit("error", { message: "Player name is required." });
    }

    // Check if player name already exists
    const existingPlayer = room.players.find(
      (p) => p.name.toLowerCase() === cleanName.toLowerCase(),
    );

    if (existingPlayer) {
      // Reconnect logic: If they are offline, let them steal their spot back
      if (existingPlayer.offline) {
        existingPlayer.socketId = socket.id; // Update to new socket
        existingPlayer.offline = false; // Mark back online

        socket.join(id);
        socket.data.roomId = id;
        socket.data.playerName = cleanName;

        socket.emit("room-joined", { roomId: id, room: getPublicRoom(room) });
        io.to(id).emit("player-joined", {
          playerName: cleanName,
          emoji: existingPlayer.emoji,
          rejoined: true,
        });
        broadcastRoom(id);

        console.log(`[REJOIN] ${cleanName} reconnected to room ${id}`);
        return;
      } else {
        // Name is taken and player is actively online
        return socket.emit("error", {
          message: `Name "${cleanName}" is already taken.`,
        });
      }
    }

    // Standard Join Logic
    if (room.players.length >= 8) {
      return socket.emit("error", { message: "Room is full! Max 8 players." });
    }

    if (room.gameState.phase !== "lobby") {
      return socket.emit("error", {
        message: "Game in progress. Wait for them to finish.",
      });
    }

    room.players.push({
      socketId: socket.id,
      name: cleanName,
      emoji: emoji || "😄",
      isHost: false,
      eliminated: false,
      offline: false,
      stats: { truth: 0, dare: 0, skip: 0 },
    });

    socket.join(id);
    socket.data.roomId = id;
    socket.data.playerName = cleanName;

    socket.emit("room-joined", { roomId: id, room: getPublicRoom(room) });
    io.to(id).emit("player-joined", {
      playerName: cleanName,
      emoji: emoji || "😄",
      rejoined: false,
    });
    broadcastRoom(id);

    console.log(`[JOIN] ${cleanName} joined room ${id}`);
  });

  // ── 3. LOBBY SETTINGS ───────────────────────────────────────────────────────
  socket.on("update-settings", ({ difficulty, gameMode }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    room.settings.difficulty = difficulty || room.settings.difficulty;
    room.settings.gameMode = gameMode || room.settings.gameMode;
    broadcastRoom(room.id);
  });

  // ── 4. GAME FLOW (START / END / CLOSE) ──────────────────────────────────────
  socket.on("start-game", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    // Check if there are at least 2 ONLINE players
    const onlinePlayers = room.players.filter((p) => !p.offline);
    if (onlinePlayers.length < 2) {
      return socket.emit("error", {
        message: "Need at least 2 online players to start.",
      });
    }

    room.gameState.phase = "playing";
    room.gameState.round = 1;
    broadcastRoom(room.id);
    io.to(room.id).emit("game-started", { settings: room.settings });
    console.log(`[START] Game started in room ${room.id}`);
  });

  // Host shows summary and resets room to lobby
  socket.on("end-game", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    room.gameState.phase = "lobby";
    room.gameState.round = 1;
    room.gameState.currentPlayer = null;
    room.gameState.currentTask = null;
    room.gameState.spinning = false;

    room.players.forEach((p) => {
      p.stats = { truth: 0, dare: 0, skip: 0 };
      p.eliminated = false;
    });

    broadcastRoom(room.id);
    io.to(room.id).emit("game-ended"); // Tells front end to show summary
    console.log(`[END] Game ended in room ${room.id}. Showing summary.`);
  });

  // Host permanently closes the room
  socket.on("close-room", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    io.to(roomId).emit("room-closed"); // Tells all players to leave
    rooms.delete(roomId);
    console.log(`[CLOSE] Room ${roomId} was permanently closed by host.`);
  });

  // ── 5. SPIN THE BOTTLE ──────────────────────────────────────────────────────
  socket.on("spin", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "playing" || room.gameState.spinning)
      return;

    room.gameState.spinning = true;
    room.gameState.phase = "spinning";

    // Exclude offline and eliminated players from being picked
    const activePlayers = room.players.filter(
      (p) => !p.eliminated && !p.offline,
    );
    if (activePlayers.length === 0) {
      // Edge case: Everyone went offline or died
      room.gameState.spinning = false;
      room.gameState.phase = "playing";
      return;
    }

    const picked =
      activePlayers[Math.floor(Math.random() * activePlayers.length)];
    room.gameState.currentPlayer = picked.name;
    room.gameState.currentPlayerId = picked.socketId;

    broadcastRoom(room.id);
    io.to(room.id).emit("spin-started", { targetPlayer: picked.name });

    // Wait for the CSS animation to finish on the front end
    setTimeout(() => {
      room.gameState.spinning = false;
      room.gameState.phase = "choice";
      broadcastRoom(room.id);
      io.to(room.id).emit("spin-result", {
        player: picked.name,
        playerId: picked.socketId,
        round: room.gameState.round,
      });
    }, 2800);
  });

  // ── 6. TASKS & QUESTIONS ────────────────────────────────────────────────────
  socket.on("pick-task", ({ type, questionText }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "choice") return;

    const isCurrentPlayer =
      socket.data.playerName === room.gameState.currentPlayer;
    const isHost = room.hostSocketId === socket.id;
    if (!isCurrentPlayer && !isHost) return;

    room.gameState.currentTask = { type, text: questionText };
    room.gameState.phase = "task";
    broadcastRoom(room.id);

    io.to(room.id).emit("task-assigned", {
      type,
      text: questionText,
      player: room.gameState.currentPlayer,
      playerId: room.gameState.currentPlayerId,
    });
  });

  // Used for "Skip" and "Switch to Dare"
  socket.on("new-question", ({ type, questionText }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "task") return;

    const isCurrentPlayer =
      socket.data.playerName === room.gameState.currentPlayer;
    const isHost = room.hostSocketId === socket.id;
    if (!isCurrentPlayer && !isHost) return;

    room.gameState.currentTask = { type, text: questionText };
    broadcastRoom(room.id);

    io.to(room.id).emit("task-assigned", {
      type,
      text: questionText,
      player: room.gameState.currentPlayer,
      playerId: room.gameState.currentPlayerId,
    });
  });

  socket.on("complete-task", ({ type }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.gameState.phase !== "task") return;

    const isCurrentPlayer =
      socket.data.playerName === room.gameState.currentPlayer;
    const isHost = room.hostSocketId === socket.id;
    if (!isCurrentPlayer && !isHost) return;

    const player = room.players.find(
      (p) => p.name === room.gameState.currentPlayer,
    );
    if (player) {
      player.stats[type] = (player.stats[type] || 0) + 1;
    }

    room.gameState.round++;
    room.gameState.phase = "playing";
    room.gameState.currentTask = null;
    room.gameState.currentPlayer = null;
    room.gameState.currentPlayerId = null;

    broadcastRoom(room.id);
    io.to(room.id).emit("task-completed", {
      type,
      round: room.gameState.round,
    });
  });

  // ── 7. CHAT & REACTIONS ─────────────────────────────────────────────────────
  socket.on("chat-message", ({ message }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !message || !message.trim()) return;

    const msg = {
      id: Date.now() + Math.random(),
      player: socket.data.playerName,
      message: message.trim().substring(0, 200),
      ts: Date.now(),
    };

    room.chat.push(msg);
    // Keep chat history lightweight
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);

    io.to(room.id).emit("chat-message", msg);
  });

  socket.on("reaction", ({ emoji }) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      io.to(roomId).emit("reaction", {
        player: socket.data.playerName,
        emoji,
        id: Date.now() + Math.random(),
      });
    }
  });

  // ── 8. HOST MODERATION ──────────────────────────────────────────────────────
  socket.on("kick-player", ({ playerName }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostSocketId !== socket.id) return; // Only host can kick

    const target = room.players.find((p) => p.name === playerName && !p.isHost);
    if (!target) return;

    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit("kicked", {
        message: "You were removed from the room by the host.",
      });
      targetSocket.leave(room.id);
      targetSocket.data.roomId = null;
    }

    // Remove player from memory
    room.players = room.players.filter((p) => p.name !== playerName);
    io.to(room.id).emit("player-left", { playerName, kicked: true });
    broadcastRoom(room.id);
  });

  // ── 9. NEVER HAVE I EVER LOGIC ──────────────────────────────────────────────
  socket.on("nihhi-admit", ({ admitted, round }) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      io.to(roomId).emit("nihhi-admit", {
        player: socket.data.playerName,
        admitted,
        round,
      });
    }
  });

  socket.on("nihhi-next", ({ questionText, round }) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.hostSocketId === socket.id) {
      io.to(room.id).emit("nihhi-question", { text: questionText, round });
    }
  });

  // ── 10. DISCONNECT HANDLING ─────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const playerName = socket.data.playerName;

    console.log(`[DISCONNECT] ${playerName || socket.id} disconnected.`);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (player) {
      // Mark them offline so they can rejoin instead of destroying their stats
      player.offline = true;
      io.to(roomId).emit("player-left", {
        playerName,
        offline: true,
        kicked: false,
      });

      // If the Host disconnected, we need to pass the crown
      if (player.isHost) {
        player.isHost = false;
        // Find the next person who is actually online
        const nextOnline = room.players.find((p) => !p.offline);

        if (nextOnline) {
          nextOnline.isHost = true;
          room.hostSocketId = nextOnline.socketId;
          io.to(roomId).emit("host-changed", { newHost: nextOnline.name });
          console.log(
            `[HOST TRANSFER] Host passed to ${nextOnline.name} in room ${roomId}`,
          );
        }
      }

      // Check if the room is now completely empty
      const activePlayers = room.players.filter((p) => !p.offline);
      if (activePlayers.length === 0) {
        rooms.delete(roomId);
        console.log(
          `[CLEANUP] Room ${roomId} deleted because all players disconnected.`,
        );
      } else {
        broadcastRoom(roomId);
      }
    }
  });
});

// ── REST API / HEALTH CHECKS ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "IGNITE server running 🔥", activeRooms: rooms.size });
});

app.get("/health", (req, res) => {
  const totalPlayers = [...rooms.values()].reduce(
    (acc, r) => acc + r.players.length,
    0,
  );
  res.json({
    ok: true,
    rooms: rooms.size,
    players: totalPlayers,
  });
});

// ── SERVER START ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🔥 IGNITE multiplayer server running on port ${PORT}`);
});
