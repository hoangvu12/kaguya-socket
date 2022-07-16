import { Server } from "socket.io";
import express from "express";
import http from "http";
import "dotenv/config";

import supabase from "./supabase.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://kaguya.live",
      "https://www.kaguya.live",
    ],
  },
  path: `/${process.env.BASE_ROUTE}/socket.io`,
});

const PORT = process.env.PORT || 3000;

// 30 minutes ms
const ROOM_DELETE_TIME = 30 * 60 * 1000;

const updateEpisode = async (roomId, episodeId) => {
  const { data, error } = await supabase
    .from("kaguya_rooms")
    .update({
      episodeId,
    })
    .match({ id: roomId });

  if (error) throw error;

  return data;
};

const joinRoom = async ({ roomId, socketId, userId }) => {
  const { data, error } = await supabase.from("kaguya_room_users").upsert(
    {
      roomId,
      userId,
      id: socketId,
    },
    {
      returning: "minimal",
    }
  );

  if (error) throw error;

  return data;
};

const leaveRoom = async (socketId) => {
  const { data, error } = await supabase
    .from("kaguya_room_users")
    .delete({ returning: "minimal" })
    .match({
      id: socketId,
    });

  if (error) throw error;

  return data;
};

const deleteRoom = async (roomId) => {
  const { data, error } = await supabase
    .from("kaguya_rooms")
    .delete()
    .match({ id: roomId });

  if (error) throw error;

  return data;
};

const getGlobalTime = () => {
  const date = new Date();
  const time = date.getTime() / 1000;

  return time;
};

const rooms = {};

io.on("connection", (socket) => {
  socket.on("join", async (roomId, user) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {};
    }

    const roomCache = rooms[roomId];

    if (roomCache.timeoutId) {
      clearTimeout(roomCache.timeoutId);
    }

    const roomEmit = (event, ...args) => {
      socket.to(roomId.toString()).emit.apply(socket, [event, ...args]);
    };

    const roomBroadcastEmit = (event, ...args) => {
      socket.broadcast
        .to(roomId.toString())
        .emit.apply(socket, [event, ...args]);
    };

    const eventEmit = (event) => {
      roomEmit("event", event);
    };

    const invalidate = () => {
      console.log("invalidate");
      roomEmit("invalidate");
    };

    await socket.join(roomId.toString());

    await joinRoom({
      roomId,
      socketId: socket.id,
      userId: user?.id || null,
    }).catch(console.error);

    eventEmit({ eventType: "join", user });

    console.log(`${user?.user_metadata.name} joined room ${roomId}`);

    invalidate();

    socket.on("disconnect", async () => {
      const sockets = await io.in(roomId.toString()).fetchSockets();

      console.log(`${user?.user_metadata.name} left room ${roomId}`);

      await leaveRoom(socket.id).catch(console.error);

      eventEmit({ eventType: "leave", user });

      if (!sockets.length) {
        roomCache.timeoutId = setTimeout(() => {
          deleteRoom(roomId).catch(console.error);
        }, ROOM_DELETE_TIME); // 10 minutes

        return;
      }

      invalidate();
    });

    socket.on("getCurrentTime", () => {
      socket.emit("currentTime", roomCache?.currentPlayerTime || 0);
    });

    socket.on("sendMessage", (message) => {
      roomEmit("message", { body: message, user });
    });

    socket.on("sendEvent", (eventType) => {
      eventEmit({ eventType, user });
    });

    socket.on("changeEpisode", async (episodeId) => {
      await updateEpisode(roomId, episodeId).catch(console.error);
      invalidate();
    });

    socket.on("changeVideoState", (videoState) => {
      if (videoState.type === "timeupdate") {
        const { currentTime } = videoState;

        roomCache.currentPlayerTime = currentTime;
      }

      roomBroadcastEmit("videoState", videoState);
    });

    socket.on("getTimeSync-backward", () => {
      const time = getGlobalTime();

      socket.emit("timeSync-backward", time);
    });

    socket.on("getTimeSync-forward", (timeAtClient) => {
      const time = getGlobalTime();

      socket.emit("timeSync-forward", time - timeAtClient);
    });
  });
});

server.listen(PORT, () => {
  console.log(`listening on *:${PORT}`);
});
