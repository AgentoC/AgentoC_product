#!/usr/bin/env python3

from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
import sys


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "docs" / "readme-multisurface-demo.png"
SOURCES = {
    "mobile": ROOT / "docs" / "new-dashboard.png",
    "desktop": ROOT / "docs" / "new-dashboard.png",
    "bot": ROOT / "docs" / "assets" / "readme-showcase" / "feishu-chat.png",
}
CANVAS_SIZE = (2400, 1440)
BACKGROUND = (244, 247, 252)
TITLE = "Desktop · Mobile · Bot / Connector"
SUBTITLE = "One AI workbench across every surface"
BOTTOM_LABEL = "Phone · Desktop · Feishu / Bot"
TITLE_FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BODY_FONT = "/System/Library/Fonts/Helvetica.ttc"


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def shadow_from_mask(mask, blur=30, alpha=90, color=(20, 28, 45)):
    layer = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    fill = Image.new("RGBA", mask.size, color + (alpha,))
    layer.paste(fill, (0, 0), mask)
    return layer.filter(ImageFilter.GaussianBlur(blur))


def add_glow(base, bbox, color, blur):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(bbox, fill=color)
    return Image.alpha_composite(base, layer.filter(ImageFilter.GaussianBlur(blur)))


def load_font(size, bold=False):
    font_path = TITLE_FONT if bold else BODY_FONT
    return ImageFont.truetype(font_path, size)


def sharpen(image, contrast=1.02, unsharp_radius=1.0, unsharp_percent=120):
    image = image.filter(ImageFilter.UnsharpMask(radius=unsharp_radius, percent=unsharp_percent, threshold=2))
    return ImageEnhance.Contrast(image).enhance(contrast)


def build_desktop_window(screen):
    outer_w, outer_h = 1540, 980
    radius = 42
    window = Image.new("RGBA", (outer_w, outer_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(window)
    draw.rounded_rectangle((0, 0, outer_w - 1, outer_h - 1), radius=radius, fill=(255, 255, 255), outline=(229, 234, 241), width=2)
    draw.rounded_rectangle((0, 0, outer_w - 1, 84), radius=radius, fill=(250, 251, 254))
    draw.rectangle((0, 50, outer_w - 1, 84), fill=(250, 251, 254))
    draw.line((0, 84, outer_w, 84), fill=(233, 237, 244), width=2)
    for index, color in enumerate(((255, 95, 87), (255, 189, 46), (40, 200, 64))):
        draw.ellipse((24 + index * 26, 28, 40 + index * 26, 44), fill=color)
    draw.rounded_rectangle((outer_w // 2 - 170, 22, outer_w // 2 + 170, 56), radius=17, fill=(244, 246, 250), outline=(234, 238, 245))
    address_font = load_font(30)
    bbox = draw.textbbox((0, 0), "agentoc", font=address_font)
    draw.text((outer_w // 2 - (bbox[2] - bbox[0]) // 2, 20), "agentoc", font=address_font, fill=(82, 92, 108))

    content_pad = 16
    content_y = 96
    content_w = outer_w - content_pad * 2
    content_h = outer_h - content_y - content_pad
    screen = screen.crop((4, 4, screen.width - 4, screen.height - 4))
    screen = ImageOps.fit(screen, (content_w, content_h), method=Image.Resampling.LANCZOS)
    screen = sharpen(screen, contrast=1.03, unsharp_radius=1.2, unsharp_percent=125)
    window.paste(screen, (content_pad, content_y), rounded_mask((content_w, content_h), 24))
    return window, rounded_mask((outer_w, outer_h), radius)


def build_phone(screen, body_w, body_h, centering=(0.5, 0.0)):
    phone = Image.new("RGBA", (body_w, body_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(phone)
    outer_radius = 72
    draw.rounded_rectangle((0, 0, body_w - 1, body_h - 1), radius=outer_radius, fill=(16, 19, 26), outline=(38, 43, 56), width=4)
    bezel = 20
    screen_left = bezel + 10
    screen_top = bezel + 12
    screen_right = body_w - bezel - 10
    screen_bottom = body_h - bezel - 14
    screen_radius = 56
    draw.rounded_rectangle((screen_left, screen_top, screen_right, screen_bottom), radius=screen_radius, fill=(0, 0, 0))
    screen_width = screen_right - screen_left
    screen_height = screen_bottom - screen_top
    screen = ImageOps.fit(screen, (screen_width, screen_height), method=Image.Resampling.LANCZOS, centering=centering)
    screen = sharpen(screen)
    phone.paste(screen, (screen_left, screen_top), rounded_mask((screen_width, screen_height), screen_radius))
    island_width, island_height = 132, 34
    island_x = body_w // 2 - island_width // 2
    island_y = 28
    draw.rounded_rectangle((island_x, island_y, island_x + island_width, island_y + island_height), radius=17, fill=(8, 9, 12))
    edge_highlight = Image.new("RGBA", (body_w, body_h), (0, 0, 0, 0))
    edge_draw = ImageDraw.Draw(edge_highlight)
    edge_draw.rounded_rectangle((8, 8, body_w - 10, body_h - 10), radius=outer_radius, outline=(255, 255, 255, 34), width=2)
    phone = Image.alpha_composite(phone, edge_highlight)
    draw = ImageDraw.Draw(phone)
    draw.rounded_rectangle((body_w // 2 - 68, body_h - 48, body_w // 2 + 68, body_h - 39), radius=4, fill=(255, 255, 255, 145))
    return phone


def paste_with_shadow(base, overlay, position, blur=24, alpha=100, offset=(0, 24)):
    shadow = Image.new("RGBA", overlay.size, (20, 25, 37, alpha))
    layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    layer.paste(shadow, (0, 0), overlay.getchannel("A"))
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)), (position[0] + offset[0], position[1] + offset[1]))
    base.alpha_composite(overlay, position)


def draw_centered_text(draw, width, text, font, y, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    x = (width - (bbox[2] - bbox[0])) // 2
    draw.text((x, y), text, font=font, fill=fill)


def build_canvas():
    canvas = Image.new("RGBA", CANVAS_SIZE, BACKGROUND + (255,))
    canvas = add_glow(canvas, (180, 180, 900, 730), (255, 255, 255, 95), 90)
    canvas = add_glow(canvas, (1520, 110, 2280, 860), (224, 233, 252, 120), 110)
    canvas = add_glow(canvas, (520, 980, 1960, 1540), (216, 225, 242, 70), 150)
    return canvas


def render(output_path):
    missing = [path for path in SOURCES.values() if not path.exists()]
    if missing:
        raise SystemExit(f"Missing source images: {', '.join(str(path) for path in missing)}")

    canvas = build_canvas()
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(84, bold=True)
    subtitle_font = load_font(40)
    label_font = load_font(30)
    draw_centered_text(draw, CANVAS_SIZE[0], TITLE, title_font, 74, (26, 34, 48))
    draw_centered_text(draw, CANVAS_SIZE[0], SUBTITLE, subtitle_font, 168, (102, 119, 144))

    desktop_screen = Image.open(SOURCES["desktop"]).convert("RGBA")
    desktop_window, desktop_mask = build_desktop_window(desktop_screen)
    desktop_position = (430, 290)
    desktop_shadow = shadow_from_mask(desktop_mask, blur=38, alpha=78)
    canvas.alpha_composite(desktop_shadow, (desktop_position[0] + 10, desktop_position[1] + 24))
    canvas.alpha_composite(desktop_window, desktop_position)

    left_phone = build_phone(Image.open(SOURCES["mobile"]).convert("RGBA"), 410, 840, centering=(0.0, 0.0)).rotate(-9, resample=Image.Resampling.BICUBIC, expand=True)
    right_phone = build_phone(Image.open(SOURCES["bot"]).convert("RGBA"), 420, 850).rotate(8, resample=Image.Resampling.BICUBIC, expand=True)
    paste_with_shadow(canvas, left_phone, (45, 405), blur=18, alpha=108, offset=(5, 20))
    paste_with_shadow(canvas, right_phone, (1868, 350), blur=18, alpha=108, offset=(5, 22))

    pill_width, pill_height = 560, 74
    pill_mask = rounded_mask((pill_width, pill_height), 20)
    pill_shadow = shadow_from_mask(pill_mask, blur=16, alpha=55)
    pill = Image.new("RGBA", (pill_width, pill_height), (255, 255, 255, 0))
    pill_draw = ImageDraw.Draw(pill)
    pill_draw.rounded_rectangle((0, 0, pill_width - 1, pill_height - 1), radius=20, fill=(255, 255, 255, 234), outline=(226, 232, 241), width=2)
    pill_x = (CANVAS_SIZE[0] - pill_width) // 2
    pill_y = 1298
    canvas.alpha_composite(pill_shadow, (pill_x, pill_y + 10))
    canvas.alpha_composite(pill, (pill_x, pill_y))
    bbox = draw.textbbox((0, 0), BOTTOM_LABEL, font=label_font)
    draw.text((CANVAS_SIZE[0] // 2 - (bbox[2] - bbox[0]) // 2, pill_y + 22), BOTTOM_LABEL, font=label_font, fill=(78, 91, 110))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, quality=95)


def main():
    output_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_OUTPUT
    render(output_path)
    print(output_path)


if __name__ == "__main__":
    main()
