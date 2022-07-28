import { Server } from "socket.io";
import http from "http";
import "dotenv/config";

import supabase from "./supabase.js";
import { createClient as createRedisClient } from "redis";

const redisClient = createRedisClient({
  url: process.env.REDIS_URL,
});
const server = http.createServer();
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

const PORT = process.env.PORT || 3002;

// 30 minutes ms
const ROOM_DELETE_TIME = 30 * 60 * 1000;

const updateEpisode = async (roomId, episode) => {
  const { data, error } = await supabase
    .from("kaguya_rooms")
    .update({
      episodeId: `${episode.sourceId}-${episode.sourceEpisodeId}`,
    })
    .match({ id: roomId });

  if (error) throw error;

  return data;
};

const updateUserInfo = async (user, info) => {
  const { userId } = user;

  await supabase
    .from("kaguya_room_users")
    .update(info, { returning: "minimal" })
    .match({
      userId,
    });
};

const joinRoom = async ({ roomId, socketId, peerId, user }) => {
  const { userId, name, avatarUrl } = user;

  await supabase.from("kaguya_room_users").upsert(
    {
      roomId,
      id: socketId,
      userId,
      name,
      avatarUrl,
      peerId,
    },
    {
      returning: "minimal",
    }
  );
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

const timeouts = {};

io.on("connection", (socket) => {
  socket.on("join", async (roomId, peerId, roomUser) => {
    const ROOM_KEY = `room:'${roomId}'`;

    if (!timeouts[roomId]) {
      timeouts[roomId] = {};
    }

    const isRoomCacheExist = await redisClient.exists(ROOM_KEY);

    if (!isRoomCacheExist) {
      await redisClient.json.set(ROOM_KEY, "$", {});
    }

    const timeout = timeouts[roomId];

    const userName = roomUser?.name || "Guest";

    if (timeout?.deleteRoom) {
      console.log("cleared timeout");

      clearTimeout(timeout?.deleteRoom);
    }

    const roomBroadcastEmit = (event, ...args) => {
      socket.broadcast
        .to(roomId.toString())
        .emit.apply(socket.broadcast, [event, ...args]);
    };

    const roomEmit = (event, ...args) => {
      socket.to(roomId.string).emit.apply(socket, [event, ...args]);
    };

    const eventEmit = (event) => {
      roomEmit("event", event);
    };

    eventEmit({ eventType: "join", user: roomUser });

    console.log(`${userName} joined room ${roomId}`);

    socket.on("getCurrentTime", async () => {
      const { currentPlayerTime } = await redisClient.json.get(
        ROOM_KEY,
        "$.currentPlayerTime"
      );

      socket.emit("currentTime", currentPlayerTime || 0);
    });

    socket.on("sendMessage", (message) => {
      roomBroadcastEmit("message", { body: message, user: roomUser });
    });

    socket.on("sendEvent", (eventType) => {
      eventEmit({ eventType, user: roomUser });
    });

    socket.on("changeEpisode", async (episode) => {
      roomEmit("changeEpisode", episode);

      await updateEpisode(roomId, episode).catch(console.error);
    });

    socket.on("changeVideoState", async (videoState) => {
      if (videoState.type === "timeupdate") {
        const { currentTime } = videoState;

        if (timeout.setPlayerTime) {
          clearTimeout(timeout.setPlayerTime);
        }

        timeouts[roomId].setPlayerTime = setTimeout(async () => {
          const isSuccess = await redisClient.json.set(
            ROOM_KEY,
            "$.currentPlayerTime",
            currentTime
          );
        }, 1000);
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

    socket.on("communicateToggle", (event) => {
      roomBroadcastEmit("communicateToggle", { event, user: roomUser });
    });

    socket.on("connectVoiceChat", (user) => {
      roomBroadcastEmit("connectVoiceChat", user);

      updateUserInfo(user, { useVoiceChat: true });
    });

    socket.on("communicateUpdate", (communicate) => {
      updateUserInfo(roomUser, communicate);
    });

    socket.on("disconnect", async () => {
      const sockets = await io.in(roomId.toString()).fetchSockets();

      console.log(`${userName} left room ${roomId}`);

      await leaveRoom(socket.id).catch(console.error);

      eventEmit({ eventType: "leave", user: roomUser });

      if (!sockets.length) {
        timeout.deleteRoom = setTimeout(() => {
          deleteRoom(roomId).catch(console.error);

          delete timeouts[roomId];

          redisClient.json.del(ROOM_KEY);
        }, ROOM_DELETE_TIME);

        return;
      }
    });

    await socket.join(roomId.toString());

    await joinRoom({
      roomId,
      socketId: socket.id,
      user: roomUser,
      peerId,
    }).catch(console.error);
  });
});

(async () => {
  await redisClient.connect();

  server.listen(PORT, () => {
    console.log(`listening on *:${PORT}`);
  });
})();
