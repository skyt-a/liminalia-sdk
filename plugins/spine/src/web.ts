import { defineWebPlugin } from "@liminalia/sdk/web";
import { createSpine } from "./part.ts";

/** Spine の立ち絵（cast.json の model.type が "spine"）。描き方は part.ts。 */
export default defineWebPlugin({
  name: "spine",
  apiVersion: 3,
  extensions: { spriteParts: { spine: createSpine } },
});
