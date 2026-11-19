#!/usr/bin/env python3
# Generates Chrome Web Store listing graphics for Video Catch, on-brand with the
# extension's purple download motif. Screenshots/promo tiles are saved as 24-bit
# RGB PNG (no alpha) as the store requires; the store icon keeps alpha.
import os, math
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "store-assets")
os.makedirs(OUT, exist_ok=True)

FONTS = "/usr/share/fonts/truetype"
def F(path, size): return ImageFont.truetype(path, size)
def poppins(w, size):
    m = {"bold":"Poppins-Bold","semibold":"Poppins-Medium","medium":"Poppins-Medium","regular":"Poppins-Regular","light":"Poppins-Light"}
    return F(f"{FONTS}/google-fonts/{m[w]}.ttf", size)
def lato(w, size):
    m = {"black":"Lato-Black","bold":"Lato-Bold","semibold":"Lato-Semibold","medium":"Lato-Medium","regular":"Lato-Regular"}
    return F(f"{FONTS}/lato/{m[w]}.ttf", size)

A1 = (99, 102, 241)    # #6366f1
A2 = (139, 92, 246)    # #8b5cf6
INK = (24, 30, 51)
MUTED = (110, 120, 145)
CARDBORDER = (228, 231, 240)

def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

def diagonal_gradient(w, h, c1, c2):
    base = Image.new("RGB", (w, h), c1)
    top = Image.new("RGB", (w, h), c2)
    mask = Image.new("L", (w, h))
    md = mask.load()
    for y in range(h):
        for x in range(0, w, 2):
            t = (x/w + y/h) / 2
            v = int(255*t)
            md[x, y] = v
            if x+1 < w: md[x+1, y] = v
    base.paste(top, (0, 0), mask)
    return base

def rounded(draw, box, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def text_w(d, s, f):
    b = d.textbbox((0,0), s, font=f); return b[2]-b[0]

# The download-catch glyph: stem + arrowhead + tray, in white. Scales to `s`.
def download_glyph(img, cx, cy, s, color=(255,255,255)):
    d = ImageDraw.Draw(img)
    stem_w = s*0.16
    d.rounded_rectangle([cx-stem_w/2, cy-s*0.5, cx+stem_w/2, cy+s*0.05], radius=stem_w/2, fill=color)
    head = s*0.30
    d.polygon([(cx-head, cy-s*0.02), (cx+head, cy-s*0.02), (cx, cy+s*0.34)], fill=color)
    tw = s*0.12
    tray_y = cy+s*0.36
    d.line([(cx-s*0.52, tray_y-s*0.10), (cx-s*0.52, tray_y+s*0.14), (cx+s*0.52, tray_y+s*0.14), (cx+s*0.52, tray_y-s*0.10)],
           fill=color, width=int(tw), joint="curve")

def brand_tile(w, h, r):
    t = diagonal_gradient(w, h, A1, A2)
    return t

# ---------- 1) store icon 128x128 (alpha kept) ----------
def store_icon():
    S = 512  # supersample
    img = Image.new("RGBA", (S, S), (0,0,0,0))
    grad = diagonal_gradient(S, S, A1, A2).convert("RGBA")
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0,0,S-1,S-1], radius=int(S*0.22), fill=255)
    img.paste(grad, (0,0), mask)
    download_glyph(img, S/2, S/2, S*0.62)
    img = img.resize((128,128), Image.LANCZOS)
    img.save(f"{OUT}/store-icon-128.png")

# ---------- 2) small promo tile 440x280 (no alpha) ----------
def promo_small():
    W,H = 440,280
    img = diagonal_gradient(W, H, A1, A2)
    d = ImageDraw.Draw(img)
    download_glyph(img, 74, 96, 92)
    d.text((128, 66), "Video Catch", font=poppins("bold", 40), fill=(255,255,255))
    d.text((130, 116), "Clip · Convert · Save", font=lato("semibold", 22), fill=(235,232,255))
    # feature line
    d.text((36, 196), "Save any video on any site — 100% on your device.",
           font=lato("medium", 18), fill=(240,238,255))
    img.save(f"{OUT}/promo-small-440x280.png")

# ---------- 3) marquee promo tile 1400x560 (no alpha) ----------
def promo_marquee():
    W,H = 1400,560
    img = diagonal_gradient(W, H, A1, A2)
    d = ImageDraw.Draw(img)
    download_glyph(img, 190, 250, 230)
    d.text((330, 150), "Video Catch", font=poppins("bold", 108), fill=(255,255,255))
    d.text((336, 285), "Clip, Convert & Save — every video, all on your device.",
           font=lato("semibold", 40), fill=(236,233,255))
    feats = ["HLS/DASH → MP4", "MP3", "Clips", "GIFs", "Subtitles", "Thumbnails"]
    x = 340; y = 380
    for fstr in feats:
        fw = text_w(d, fstr, lato("semibold", 30))
        rounded(d, [x, y, x+fw+44, y+58], 29, fill=(255,255,255))
        d.text((x+22, y+13), fstr, font=lato("semibold", 30), fill=A1)
        x += fw+44+18
        if x > W-260:
            x = 340; y += 78
    img.save(f"{OUT}/promo-marquee-1400x560.png")

# ---------- popup mock (used inside screenshots) ----------
def popup_mock(scale=1.0):
    W,H = int(360*scale), int(520*scale)
    p = Image.new("RGB", (W, H), (255,255,255))
    d = ImageDraw.Draw(p)
    s = scale
    # header gradient
    hdr = diagonal_gradient(W, int(96*s), A1, A2)
    p.paste(hdr, (0,0))
    download_glyph(p, 40*s, 48*s, 44*s)
    d.text((72*s, 26*s), "Video Catch", font=poppins("bold", int(24*s)), fill=(255,255,255))
    d.text((74*s, 58*s), "3 videos found", font=lato("medium", int(14*s)), fill=(235,232,255))
    # tabs
    d.text((28*s, 112*s), "Videos", font=lato("bold", int(15*s)), fill=A1)
    d.text((150*s, 112*s), "Downloads", font=lato("semibold", int(15*s)), fill=MUTED)
    d.line([(28*s,138*s),(120*s,138*s)], fill=A1, width=int(3*s))
    # cards
    cards = [("How to build an extension","VIDEO  ·  network","Download"),
             ("Physics — Lecture 12 (HLS)","1080p  ·  stream","Merge & Save"),
             ("Reel — travel highlights","VIDEO  ·  reddit","Download")]
    y = 158*s
    for title, tag, btn in cards:
        rounded(d, [16*s, y, W-16*s, y+104*s], 14*s, fill=(250,250,253), outline=CARDBORDER, width=1)
        rounded(d, [30*s, y+18*s, 30*s+56*s, y+18*s+56*s], 10*s, fill=(238,236,252))
        download_glyph(p, 30*s+28*s, y+18*s+28*s, 30*s, color=A2)
        d.text((100*s, y+22*s), title, font=lato("bold", int(15*s)), fill=INK)
        d.text((100*s, y+46*s), tag, font=lato("medium", int(12*s)), fill=MUTED)
        bw = text_w(d, btn, lato("bold", int(13*s))) + 28*s
        rounded(d, [100*s, y+66*s, 100*s+bw, y+66*s+30*s], 8*s, fill=A1)
        d.text((100*s+14*s, y+72*s), btn, font=lato("bold", int(13*s)), fill=(255,255,255))
        y += 116*s
    return p

def soft_bg(W,H):
    img = Image.new("RGB",(W,H),(247,246,252))
    top = Image.new("RGB",(W,H),(238,235,251))
    mask = Image.new("L",(W,H))
    md = mask.load()
    for yy in range(H):
        v = int(200*(1-yy/H))
        for xx in range(0,W,3):
            md[xx,yy]=v
            if xx+1<W: md[xx+1,yy]=v
            if xx+2<W: md[xx+2,yy]=v
    img.paste(top,(0,0),mask)
    return img

def shot(fname, headline, sub, bullets, with_popup=True):
    W,H = 1280,800
    img = soft_bg(W,H)
    d = ImageDraw.Draw(img)
    # left copy
    d.text((84, 150), headline[0], font=poppins("bold", 62), fill=INK)
    if len(headline)>1:
        d.text((84, 222), headline[1], font=poppins("bold", 62), fill=A1)
    # keep the subline clear of the right-hand visual
    sub_font = lato("regular", 26)
    sub_max = 620 if with_popup else 560
    while text_w(d, sub, sub_font) > sub_max and len(sub) > 10:
        sub = sub.rsplit(" ", 1)[0]
    d.text((86, 322), sub, font=sub_font, fill=MUTED)
    y = 400
    for b in bullets:
        # bullet chip
        rounded(d, [86, y, 86+40, y+40], 12, fill=A1)
        download_glyph(img, 86+20, y+20, 22)
        d.text((146, y+4), b, font=lato("semibold", 27), fill=INK)
        y += 66
    # right visual
    if with_popup:
        pm = popup_mock(1.2)
        # subtle shadow
        sh = Image.new("RGBA", (pm.width+40, pm.height+40), (0,0,0,0))
        ImageDraw.Draw(sh).rounded_rectangle([20,26,pm.width+20,pm.height+26], radius=24, fill=(80,70,160,70))
        px, py = 792, 150
        img.paste(sh, (px-20, py-20), sh)
        pmr = Image.new("RGB",(pm.width,pm.height),(255,255,255))
        pmr.paste(pm,(0,0))
        # rounded corners on the popup
        m = Image.new("L", pm.size, 0)
        ImageDraw.Draw(m).rounded_rectangle([0,0,pm.width-1,pm.height-1], radius=20, fill=255)
        img.paste(pmr, (px, py), m)
    else:
        # feature grid
        items = [("HLS / DASH","→ clean MP4"),("Extract","MP3 / M4A"),
                 ("Trim","clips"),("Export","GIFs"),("Subtitles","SRT / VTT / TXT"),("Grab","thumbnails")]
        gx, gy = 720, 152; cw, ch = 250, 150; gap=18
        for i,(a,b) in enumerate(items):
            cx = gx + (i%2)*(cw+gap); cy = gy + (i//2)*(ch+gap)
            rounded(d, [cx,cy,cx+cw,cy+ch], 20, fill=(255,255,255), outline=CARDBORDER, width=2)
            download_glyph(img, cx+42, cy+46, 40, color=A2)
            d.text((cx+26, cy+74), a, font=poppins("bold", 25), fill=INK)
            d.text((cx+26, cy+110), b, font=lato("medium", 21), fill=MUTED)
    # footer strip
    rounded(d, [84, 706, 1196, 754], 24, fill=(255,255,255), outline=CARDBORDER, width=2)
    d.text((108, 716), "100% on your device  ·  no servers  ·  no tracking  ·  no sign-in",
           font=lato("semibold", 22), fill=A1)
    img.save(f"{OUT}/{fname}")

store_icon()
promo_small()
promo_marquee()
shot("screenshot-1-catch.png",
     ["Catch any video,", "on any site"],
     "Detects videos as they play — download with one click.",
     ["One-click download","Works on any website","In-video Catch button"], with_popup=True)
shot("screenshot-2-toolkit.png",
     ["One video,", "every format"],
     "Merge and convert — all on your device.",
     ["Merge HLS & DASH to MP4","MP3 · Clips · GIFs","Subtitles & thumbnails"], with_popup=False)
shot("screenshot-3-private.png",
     ["Private by", "design"],
     "The conversion runs on your device with bundled FFmpeg.",
     ["No servers, no cloud","No tracking or accounts","Quality picker & fast saves"], with_popup=True)
print("done ->", OUT)
for f in sorted(os.listdir(OUT)):
    im = Image.open(os.path.join(OUT,f))
    print(f"  {f}: {im.size[0]}x{im.size[1]} {im.mode}")
