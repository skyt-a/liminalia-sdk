window.TYRANO_TATIE_SETTINGS = {
    "schemaVersion": 2,
    "defaultCharacter": "mio",
    "frameReference": {
        "character": "mio",
        "appearance": "uniform",
        "variant": "normal"
    },
    "characters": {
        "mio": {
            "defaultAppearance": "uniform",
            "appearances": {
                "uniform": {
                    "label": "制服",
                    "variants": {
                        "normal": { "storage": "mio/uniform_normal.png", "frame": { "width": 400, "height": 700, "positions": { "left": { "left": 80, "top": 20 }, "center": { "left": 440, "top": 20 }, "right": { "left": 800, "top": 20 } } } },
                        "smile": { "storage": "mio/uniform_smile.png", "cacheKey": "2", "frame": { "width": 400, "height": 700, "positions": { "left": { "left": 80, "top": 20 }, "center": { "left": 440, "top": 20 }, "right": { "left": 800, "top": 20 } } } }
                    }
                },
                "casual": {
                    "label": "私服",
                    "variants": {
                        "normal": { "storage": "mio/casual_normal.png", "frame": { "width": 420, "height": 720, "positions": { "left": { "left": 70, "top": 0 }, "center": { "left": 430, "top": 0 }, "right": { "left": 790, "top": 0 } } } }
                    }
                }
            }
        },
        "sora": {
            "variants": {
                "normal": { "storage": "sora/normal.png", "frame": { "width": 380, "height": 680, "positions": { "right": { "left": 820, "top": 40 } } } }
            }
        }
    }
};
