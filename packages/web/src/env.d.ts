/// <reference types="vite/client" />

/** テスト版の書き出しか（lim build --feedback。vite.config.ts の define。開発サーバーと製品の書き出しでは false）。 */
declare const __LIMINALIA_FEEDBACK__: boolean;
/** 遊ばれ方の統計を入れるか（liminalia.json の build.analytics。vite.config.ts の define。書かない作品と開発サーバーでは false）。 */
declare const __LIMINALIA_ANALYTICS__: boolean;
