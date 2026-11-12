"""Create the share card from the original vector mark; no generated brand art."""
from pathlib import Path
from tempfile import TemporaryDirectory
import cairosvg
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parent
assets = root / 'src' / 'assets'
with TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    font = TTFont(assets / 'dm-sans-latin.woff2')
    font = instantiateVariableFont(font, {'wght': 550}, inplace=True)
    font.flavor = None
    font.save(tmp / 'dm.ttf')
    def f(size): return ImageFont.truetype(str(tmp / 'dm.ttf'), size)
    cairosvg.svg2png(url=str(assets / 'brand-0cf450d05c3b.svg'), write_to=str(tmp / 'brand.png'), output_width=330, output_height=84)
    canvas = Image.new('RGB', (1200, 630), '#f8f9fb')
    draw = ImageDraw.Draw(canvas)
    logo = Image.open(tmp / 'brand.png').convert('RGBA')
    canvas.paste(logo, (48, 40), logo)
    draw.text((66, 168), 'SEU ASSISTENTE PESSOAL COM IA', font=f(17), fill='#0061fd')
    draw.text((60, 216), 'Sua rotina,', font=f(85), fill='#111827')
    draw.text((60, 309), 'mais leve.', font=f(85), fill='#0061fd')
    draw.text((65, 450), 'Finanças, tarefas e lembretes.', font=f(25), fill='#596171')
    draw.text((65, 489), 'Tudo em uma conversa no WhatsApp.', font=f(25), fill='#596171')
    draw.rounded_rectangle((760, 155, 1135, 492), radius=22, fill='white', outline='#d5dfed', width=2)
    draw.text((792, 189), 'Astra', font=f(24), fill='#111827')
    draw.text((792, 231), 'Seu dia, em ordem.', font=f(17), fill='#718098')
    draw.line((790, 275, 1105, 275), fill='#e2e8f1', width=2)
    for y, heading, detail in [(304, 'Almoço registrado', 'R$ 42,00 · Alimentação'), (385, 'Dentista na agenda', 'Amanhã · 15h')]:
        draw.ellipse((794, y + 2, 819, y + 27), fill='#e5efff')
        draw.line((801, y + 15, 806, y + 20, 814, y + 10), fill='#0061fd', width=2)
        draw.text((835, y), heading, font=f(20), fill='#233651')
        draw.text((835, y + 31), detail, font=f(16), fill='#78879c')
    draw.text((795, 516), 'Interface ilustrativa', font=f(14), fill='#7b889c')
    draw.line((65, 576, 1135, 576), fill='#dce1e8', width=1)
    canvas.save(assets / 'social.png', optimize=True)
