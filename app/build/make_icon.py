"""生成 ServerPilot 应用图标（.ico / .png）"""
from PIL import Image, ImageDraw, ImageFilter

S = 1024


def vertical_gradient(w, h, c1, c2):
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        grad.putpixel((0, y), tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)))
    return grad.resize((w, h))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def paste_rounded(canvas, img, box, radius):
    w, h = box[2] - box[0], box[3] - box[1]
    mask = rounded_mask(max(w, h), radius).resize((w, h))
    canvas.paste(img, (box[0], box[1]), mask)


canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 底板
bg = vertical_gradient(S, S, (28, 32, 42), (9, 10, 13))
paste_rounded(canvas, bg, (0, 0, S, S), 228)

draw = ImageDraw.Draw(canvas)
# 内侧描边
draw.rounded_rectangle([4, 4, S - 5, S - 5], radius=224, outline=(255, 255, 255, 26), width=3)

# 顶部柔光
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([120, -420, S - 120, 340], fill=(120, 160, 255, 46))
glow = glow.filter(ImageFilter.GaussianBlur(90))
canvas.alpha_composite(Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), rounded_mask(S, 228)))

# 两个“服务器单元”
unit_w, unit_h = 584, 152
for i, top in enumerate((300, 566)):
    grad = vertical_gradient(unit_w, unit_h, (150, 178, 255), (52, 98, 235))
    paste_rounded(canvas, grad, (220, top, 220 + unit_w, top + unit_h), 38)

    # 顶部高光
    hl = Image.new("RGBA", (unit_w, unit_h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.rounded_rectangle([0, 0, unit_w - 1, int(unit_h * 0.55)], radius=38, fill=(255, 255, 255, 34))
    hl = hl.filter(ImageFilter.GaussianBlur(8))
    canvas.alpha_composite(Image.composite(hl, Image.new("RGBA", (unit_w, unit_h), (0, 0, 0, 0)),
                                           rounded_mask(max(unit_w, unit_h), 38).resize((unit_w, unit_h))),
                           (220, top))

    d = ImageDraw.Draw(canvas)
    # 指示灯
    d.ellipse([262, top + 62, 292, top + 92], fill=(255, 255, 255, 245))
    # 插槽
    d.rounded_rectangle([340, top + 66, 500, top + 78], radius=6, fill=(255, 255, 255, 200))
    d.rounded_rectangle([536, top + 66, 762, top + 78], radius=6, fill=(255, 255, 255, 120))

canvas.save("icon.png")
canvas.save("icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("icon generated")
