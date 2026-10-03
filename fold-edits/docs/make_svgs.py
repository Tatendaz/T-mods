"""Draws docs/fold-edits-dark.svg and docs/fold-edits-light.svg. Run: python3 docs/make_svgs.py"""
import html, os

CW, LH, PAD, FS = 8.4, 22, 20, 14
FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

THEMES = {
    "dark": dict(bg="#16181d", fg="#e6e6e6", dim="#8b919a", dot="#3b9cff", pill="#116329", pill_fg="#e6e6e6",
                 add_bg="#163a24", add_fg="#7ee2a0", del_bg="#4a1f22", del_fg="#ff9a9a", num="#6b7280",
                 border="#2b2f36", label="#8b919a"),
    "light": dict(bg="#ffffff", fg="#1f2328", dim="#6e7781", dot="#0969da", pill="#aceebb", pill_fg="#1f2328",
                  add_bg="#dafbe1", add_fg="#116329", del_bg="#ffebe9", del_fg="#a40e26", num="#8c959f",
                  border="#d0d7de", label="#6e7781"),
}

COLS = 88
W = PAD * 2 + COLS * CW

def text(x_col, y, s, color, bold=False):
    # Renderers collapse edge spaces, which textLength would then stretch
    # across: place the trimmed run at its own column instead.
    x_col += len(s) - len(s.lstrip())
    s = s.strip()
    w = len(s) * CW
    weight = ' font-weight="700"' if bold else ""
    return (f'<text x="{PAD + x_col * CW:.1f}" y="{y}" fill="{color}"{weight} textLength="{w:.1f}" '
            f'lengthAdjust="spacingAndGlyphs">{html.escape(s)}</text>')

def pill(x_col, y, label, t):
    w = (len(label) + 2) * CW
    x = PAD + x_col * CW
    return (f'<rect x="{x:.1f}" y="{y - 15}" width="{w:.1f}" height="20" rx="3" fill="{t["pill"]}"/>'
            + text(x_col + 1, y, label, t["pill_fg"]))

def tool_row(y, t, opened):
    out = [f'<circle cx="{PAD + 4}" cy="{y - 5}" r="4" fill="{t["dot"]}"/>',
           text(2, y, "Update", t["fg"], bold=True), text(8, y, "(src/invite.ts)", t["fg"])]
    y += LH
    line = "⎿  Updated src/invite.ts (+1 -1) "
    out.append(text(2, y, line, t["dim"]))
    out.append(pill(2 + len(line), y, "▾ hide" if opened else "▸ show diff", t))
    return out, y

def diff_row(y, t, num, mark, code):
    out = []
    bg = {"+": t["add_bg"], "-": t["del_bg"]}.get(mark)
    if bg:
        out.append(f'<rect x="{PAD + 5 * CW:.1f}" y="{y - 15}" width="{(COLS - 5) * CW:.1f}" height="{LH}" fill="{bg}"/>')
    color = {"+": t["add_fg"], "-": t["del_fg"]}.get(mark, t["fg"])
    out.append(text(5, y, f"{num:>3} {mark or ' '} ", t["num"] if not mark else color))
    out.append(text(11, y, code, color if mark else t["fg"]))
    return out

def build(name):
    t = THEMES[name]
    parts, y = [], PAD + 18
    parts.append(text(0, y, "Folded (default)", t["label"]))
    y += LH + 6
    rows, y = tool_row(y, t, opened=False)
    parts += rows
    y += LH + 14
    parts.append(f'<line x1="{PAD}" y1="{y - 18}" x2="{W - PAD}" y2="{y - 18}" stroke="{t["border"]}"/>')
    parts.append(text(0, y, "After clicking show diff", t["label"]))
    y += LH + 6
    rows, y = tool_row(y, t, opened=True)
    parts += rows
    for num, mark, code in [
        (37, "", "};"),
        (38, "-", "const answer = await requestInvite(deps, { email, from });"),
        (38, "+", 'const answer = await requestInvite(deps, { email, from, consent: "yes" });'),
        (39, "", "return answer;"),
    ]:
        y += LH
        parts += diff_row(y, t, num, mark, code)
    y += LH + 4
    parts.append(pill(5, y, "▾ hide", t))
    H = y + PAD
    body = "\n  ".join(parts)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H}" viewBox="0 0 {W:.0f} {H}" '
            f'font-family="{FONT}" font-size="{FS}" xml:space="preserve" role="img" aria-label="fold-edits: an edit folded to one line '
            f'with a green show diff button, then opened with hide buttons above and below the diff">\n'
            f'  <rect x="0.5" y="0.5" width="{W - 1:.0f}" height="{H - 1}" rx="8" fill="{t["bg"]}" stroke="{t["border"]}"/>\n  {body}\n</svg>\n')

out = os.path.dirname(os.path.abspath(__file__))
for name in THEMES:
    with open(f"{out}/fold-edits-{name}.svg", "w") as f:
        f.write(build(name))
print("ok")
