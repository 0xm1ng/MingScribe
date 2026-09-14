"""生成 MingScribe 桌面版所需的全套图标。

Tauri 在 Windows 上构建时强制要求 `icons/icon.ico`，此外 bundle 配置里还引用了
多个 PNG / ICNS。本脚本用 Pillow 程序化绘制一枚「打开的书」图标，输出：

  src-tauri/icons/32x32.png
  src-tauri/icons/128x128.png
  src-tauri/icons/128x128@2x.png      (= 256x256)
  src-tauri/icons/icon.png            (= 512x512)
  src-tauri/icons/icon.ico            (含多尺寸)

ICNS 为 macOS 专用，Windows 构建不需要，可以不生成；如需可另跑 tauri icon。

用法：
  python tools/gen_icons.py
"""

import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src-tauri", "icons")

# 配色：深蓝底 + 米白书页，与阅读器的浅色主题呼应
BG_TOP = (37, 52, 84)
BG_BOTTOM = (23, 33, 56)
PAGE = (247, 245, 240)
PAGE_EDGE = (214, 210, 200)
ACCENT = (94, 147, 232)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw_icon(size):
    """在 size×size 的画布上绘制图标（以千分比坐标保证任意尺寸一致）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def px(v):
        return v / 1000.0 * size

    # 圆角方形背景（竖向渐变）
    radius = px(210)
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / max(1, size - 1)
        bd.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, t) + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # 书：左右两页，中间留出书脊
    top = px(280)
    bottom = px(730)
    left_out = px(190)
    right_out = px(810)
    spine_l = px(470)
    spine_r = px(530)

    def page(poly):
        d.polygon(poly, fill=PAGE + (255,))
        d.line(poly + [poly[0]], fill=PAGE_EDGE + (255,), width=max(1, int(px(6))))

    # 左页（外缘略低，模拟翻开的弧度）
    page([
        (left_out, top + px(28)),
        (spine_l, top),
        (spine_l, bottom),
        (left_out, bottom - px(28)),
    ])
    # 右页
    page([
        (spine_r, top),
        (right_out, top + px(28)),
        (right_out, bottom - px(28)),
        (spine_r, bottom),
    ])

    # 书脊高光
    d.rectangle([spine_l, top, spine_r, bottom], fill=ACCENT + (255,))

    # 两页上的文字行（横线）：三行居中分布在 320~690 之间
    line_h = max(1, int(px(36)))
    rows = [px(360), px(480), px(600)]
    for y in rows:
        d.rounded_rectangle(
            [left_out + px(80), y, spine_l - px(80), y + line_h],
            radius=line_h // 2, fill=(196, 204, 218, 255),
        )
        d.rounded_rectangle(
            [spine_r + px(80), y, right_out - px(80), y + line_h],
            radius=line_h // 2, fill=(196, 204, 218, 255),
        )

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }

    master = draw_icon(512)
    master.save(os.path.join(OUT_DIR, "icon.png"))

    for name, s in sizes.items():
        draw_icon(s).save(os.path.join(OUT_DIR, name))
        print("wrote", name, s)

    # ICO 内含多尺寸，供 Windows 在任务栏/资源管理器按需取用
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(os.path.join(OUT_DIR, "icon.ico"), sizes=ico_sizes)
    print("wrote icon.ico", ico_sizes)

    print("OK ->", OUT_DIR)


if __name__ == "__main__":
    main()
