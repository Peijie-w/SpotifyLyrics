const { contextBridge, ipcRenderer } = require("electron");

const STATE_CHANNEL = "lyrics:state";
const PLAYER_CONTROL_CHANNEL = "spotify:player-control";

contextBridge.exposeInMainWorld("floatingLyrics", {
  onStateChange(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(STATE_CHANNEL, listener);

    return () => {
      ipcRenderer.removeListener(STATE_CHANNEL, listener);
    };
  },
  controlPlayer(action) {
    return ipcRenderer.invoke(PLAYER_CONTROL_CHANNEL, action);
  }
});
