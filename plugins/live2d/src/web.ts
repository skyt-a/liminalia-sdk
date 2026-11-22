import { defineWebPlugin } from "@liminalia/sdk/web";
import { createLive2d } from "./part.ts";

/** Live2D の立ち絵（cast.json の model.type が "live2d"）。描き方は part.ts。 */
export default defineWebPlugin({
  name: "live2d",
  apiVersion: 3,
  extensions: { spriteParts: { live2d: createLive2d } },
});
