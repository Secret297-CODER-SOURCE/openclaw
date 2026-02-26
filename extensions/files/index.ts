import type { ChannelPlugin } from "../../src/plugin-sdk";

const plugin: ChannelPlugin = {
  name: "files",
  async register(ctx) {
    console.log("Files extension loaded");
  },
};

export default plugin;
