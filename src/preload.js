const { contextBridge, ipcRenderer } = require("electron");

const STATE_CHANNEL = "lyrics:state";
const PLAYER_CONTROL_CHANNEL = "spotify:player-control";
const PREPARE_TRANSLATION_CHANNEL = "lyrics:prepare-translation";
const APP_QUIT_CHANNEL = "app:quit";

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
  },
  prepareTranslation(targetLanguage) {
    return ipcRenderer.invoke(PREPARE_TRANSLATION_CHANNEL, targetLanguage);
  },
  quitApp() {
    return ipcRenderer.invoke(APP_QUIT_CHANNEL);
  }
});
