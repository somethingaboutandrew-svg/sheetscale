#!/usr/bin/env python3
"""App Store Connect metadata for SheetScale. Checks Apple's length limits and competitor names, writes appstore/metadata.json."""
import json
from pathlib import Path
SITE='https://somethingaboutandrew-svg.github.io/sheetscale/'
m = {
 "app_name": "SheetScale: Measure PDF Plans",
 "subtitle": "Plan sheets to scale, offline",
 "promotional_text": "Calibrate any plan sheet and measure length, area, acres and counts right on the PDF. Markups, layers, combine and lossless compress. Your files never leave your Mac.",
 "keywords": "takeoff,blueprint,construction,estimating,redline,markup,area,acres,layers,combine,compress,survey",
 "description": """Mark up and measure plan sheets on your Mac, to scale, without a subscription or an account.

SheetScale is built for people who review drawings and reports: contractors, estimators, architects, engineers, surveyors and environmental consultants. Open a PDF, set the scale once, and read lengths, square feet and acres right on the page.

MEASURE TO SCALE
• Calibrate by clicking both ends of a known length, such as a scale bar or a dimension, or choose a standard engineering, architectural or metric scale
• Length, polylength, perimeter, area (sq ft and acres, or m² and hectares) and count tools
• Labels drawn on the sheet, live totals in the Markups list, and CSV export
• The scale is saved in the PDF as a standard measurement dictionary

MARK UP
• Clouds, callouts, text boxes, highlights, arrows, lines, polylines, polygons, rectangles, ellipses and pen
• Line and fill colour, opacity, line width and solid, dashed, dotted or cloud borders
• Save favourite styles as presets
• Undo, redo, copy, paste and multi-select

LAYERS
• Show or hide the PDF's own layers (for example topography or utilities)
• Create your own markup layers, then hide or lock them
• Layers are saved as real PDF layers that other PDF apps can read

SAVE YOUR WAY
• Keep markups editable as standard PDF annotations, or flatten them into the page
• Combine PDFs into one file and turn images into PDF pages
• Reorder, rotate, insert, extract and delete pages
• Reduce file size losslessly: images are never downsampled or re-encoded

BUILT FOR BIG REPORT SETS
• Tested with combined 300-page reports of about 125 MB
• Pages render in the background so scrolling stays smooth

PRIVATE BY DESIGN
• Everything runs on your Mac; nothing is uploaded
• No account, no sign-in, no analytics, no tracking
• Recent files stay in the app's private storage on your Mac

Opens PDF files and images (PNG, JPG, TIFF including multi-page, GIF, BMP and WebP). Measurements are as accurate as the drawing and the scale you set; check a known dimension after calibrating.""",
 "whats_new": "First release on the Mac App Store.\n• Calibrated length, area, perimeter and count measurement\n• Markups on real PDF layers\n• Combine PDFs and lossless size reduction\n• Light glass-style look, with the Graphite dark theme in the Appearance menu",
 "support_url": SITE+"support.html",
 "marketing_url": SITE,
 "pricing": {"model": "Paid app, one-time purchase", "price_usd": 19.99, "in_app_purchases": "None", "subscription": "None", "launch_discount": "None (no scheduled price changes)", "net_per_us_sale_usd_at_15pct": 16.99, "volume_purchase_discount": "Optional: 50% off 20+ copies via Apple Business Manager"},
 "privacy_policy_url": SITE+"privacy.html",
 "copyright": "2026 Andrew Pocta",
 "primary_category": "Productivity",
 "secondary_category": "Business",
 "bundle_id": "com.andrewpocta.sheetscale",
 "sku": "SHEETSCALE-MAC-001",
 "version": "1.2.0",
 "minimum_macos": "12.0",
 "age_rating": {
   "result": "4+",
   "answers": {k:"None" for k in ["Cartoon or Fantasy Violence","Realistic Violence","Prolonged Graphic or Sadistic Realistic Violence","Profanity or Crude Humor","Mature/Suggestive Themes","Horror/Fear Themes","Medical/Treatment Information","Alcohol, Tobacco, or Drug Use or References","Simulated Gambling","Sexual Content or Nudity","Graphic Sexual Content and Nudity","Contests"]} | {
     "Unrestricted Web Access":"No","Gambling":"No","Loot boxes":"No","User-generated content shared with others":"No","Messaging and chat":"No","Advertising":"No","Parental controls":"No","Age assurance":"No","Health or wellness topics":"No"}
 },
 "app_privacy": {"data_collection": "No, we do not collect data from this app", "label_shown": "Data Not Collected", "tracking": "No"},
 "export_compliance": {"ITSAppUsesNonExemptEncryption": False, "reason": "SheetScale does not use encryption to protect data or communications. It makes no network connections. The only cryptography in the app is decrypting owner-password-restricted PDFs so they can be displayed (qpdf/pdf.js PDF security handler), which falls under the exemption for decryption used for copy protection / document access, not for securing data."},
 "content_rights": "Does not contain, show or access third-party content",
 "review_notes": """SheetScale is a PDF markup and measurement tool that works entirely offline. No account, sign-in or network connection is needed, and the app makes no network connections (it has no network entitlement).

How to test (about 2 minutes):
1. Download the sample plan sheet in Safari: """+SITE+"""samples/sample-plan.pdf (also attached to this submission as SheetScale-review-sample.pdf).
2. In SheetScale choose File > Open… (Cmd+O) and pick the sample. A one-page site plan opens.
3. Set the scale: press K, click the "0" tick of the scale bar at the right of the sheet, then the "100 FT" tick, type 100, choose ft and click Apply. The top bar then reads "Calibrated".
4. Measure: press 4 (Area), click several points around the green wetland and double-click to finish. The area appears in square feet and acres on the sheet and in the Style panel. Press 1 (Length) and drag to measure a distance.
5. Open the Layers tab on the right: hide "Topography" to see the PDF's own layers switch off.
6. File > Save As / Flatten… (Shift+Cmd+S): choose Editable markups or Flattened, then save anywhere you like. The saved PDF opens in Preview with the markups.
7. File > Combine PDFs… and File > Reduce File Size… work on any PDFs you pick.

Sandbox: files are accessed only through the Open and Save panels, drag and drop, or Finder's Open With (user-selected read-write entitlement). Recent files and autosave are stored in the app's own container.

Open-source components and their licenses: Help > Acknowledgements.""",
}
lim={"app_name":30,"subtitle":30,"promotional_text":170,"keywords":100,"description":4000,"whats_new":4000}
for k,n in lim.items():
    L=len(m[k]); print(f"{k}: {L}/{n}", "OK" if L<=n else "TOO LONG"); assert L<=n
assert ' ,' not in m['keywords'] and ', ' not in m['keywords']
banned=['bluebeam','revu','acrobat','adobe','pdf expert','drawboard','planswift','togal']
for k,v in m.items():
    if isinstance(v,str): 
        for b in banned: assert b not in v.lower(), (k,b)
import os
json.dump(m,open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','appstore','metadata.json'),'w'),indent=2,ensure_ascii=False)
# words in keywords repeated in name/subtitle?
nm=set((m['app_name']+' '+m['subtitle']).lower().replace(':',' ').replace('&',' ').replace(',',' ').split())
print('dup keywords:', [k for k in m['keywords'].split(',') if k in nm])

# Human-readable copy for pasting into App Store Connect
L = ['# App Store Connect metadata (copy and paste)', '', 'Generated by `scripts/appstore-metadata.py` (it checks Apple\'s length limits and that no competitor trademark appears). Edit the script, not this file.', '']
def sec(t, v, lim=None):
    L.extend([f'## {t}' + (f' ({len(v)}/{lim} characters)' if lim else ''), '', '```', v, '```', ''])
sec('Name', m['app_name'], 30); sec('Subtitle', m['subtitle'], 30); sec('Promotional text', m['promotional_text'], 170)
sec('Keywords', m['keywords'], 100); sec('Description', m['description'], 4000); sec("What's New in This Version", m['whats_new'], 4000)
L += ['## URLs', '', f"- Support URL: {m['support_url']}", f"- Marketing URL: {m['marketing_url']}", f"- Privacy Policy URL: {m['privacy_policy_url']}", '']
p=m['pricing']
L += ['## Price (Pricing and Availability)', '', f"- {p['model']}: **${p['price_usd']}** (US price tier; Apple sets other countries' prices from it)", f"- In-app purchases: {p['in_app_purchases']}. Subscription: {p['subscription']}. Launch discount: {p['launch_discount']}.", f"- Proceeds with the Small Business Program (Apple keeps 15%): about **${p['net_per_us_sale_usd_at_15pct']}** per US sale", f"- {p['volume_purchase_discount']}", '']
L += ['## App information', '', f"- Bundle ID: `{m['bundle_id']}`", f"- SKU: `{m['sku']}`", f"- Primary category: {m['primary_category']}", f"- Secondary category: {m['secondary_category']}", f"- Copyright: {m['copyright']}", f"- Version: {m['version']}", f"- Minimum macOS: {m['minimum_macos']}", f"- Content rights: {m['content_rights']}", '']
L += ['## Age rating questionnaire (result: 4+)', '', '| Question | Answer |', '|---|---|'] + [f'| {k} | {v} |' for k, v in m['age_rating']['answers'].items()] + ['']
L += ['## App Privacy', '', f"- Do you or your third-party partners collect data from this app? **{m['app_privacy']['data_collection']}**", f"- Resulting label: **{m['app_privacy']['label_shown']}**", f"- Tracking: **{m['app_privacy']['tracking']}**", '']
L += ['## Export compliance', '', f"- `ITSAppUsesNonExemptEncryption` = `false` is set in Info.plist, so App Store Connect will not ask on each build.", f"- Why: {m['export_compliance']['reason']}", '']
L += ['## App Review notes (App Review Information > Notes)', '', '- Sign-in required: **No**', '- Attachment: `appstore/review/SheetScale-review-sample.pdf`', '', '```', m['review_notes'], '```', '']
L += ['## Screenshots (Mac, 2880 x 1800)', '', 'In `appstore/screenshots/`, upload in this order:', ''] + [f'{i+1}. `{p.name}`' for i, p in enumerate(sorted((Path(os.path.dirname(os.path.abspath(__file__))).parent / 'appstore' / 'screenshots').glob('*.png')))] + ['']
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'appstore', 'METADATA.md'), 'w').write('\n'.join(L))
print('wrote appstore/METADATA.md')
