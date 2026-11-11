# Mileage Log

The State of Maryland **Vehicle Mileage Log** (Appendix 2, *Policies and Procedures for Drivers of State Vehicles*), filled out on your phone.

- Log each day: where you went (`W, JHH, BCoFD` becomes `H → W → JHH → BCoFD → H`) and the ending odometer.
- Snap the odometer: the photo is read **on the phone** and dates the entry from when the photo was taken. Pick a week of photos at once to catch up.
- At month's end: **Review, sign & send** builds the official form as a PDF, signed with your saved signature, and opens your phone's share menu so you send it from your own email.

## Privacy

Everything stays on the device: your details, your log, your signature and your photos (photos are read and then discarded). There is no server and no account. The only things that leave the phone are the PDFs and backups you choose to share.

Because the log lives on the phone, use **Vehicle, driver & backup → Back up now** from time to time, and **Restore a backup** on a new phone.

## Install

Open the site on your phone.

- **iPhone (Safari):** Share → **Add to Home Screen**. Set up the log from the Home Screen icon. On iPhone, the Home Screen app keeps its own storage, separate from Safari.
- **Android (Chrome):** tap **Install** when offered, or ⋮ → **Add to Home screen**.

## Hosting

It is a static site: the files in this folder are the whole app. GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / root**.

## Credits

- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) builds the PDF.
- [Tesseract.js](https://github.com/naptha/tesseract.js) and [tesseract.js-core](https://github.com/naptha/tesseract.js-core) (Apache 2.0), with the [Tesseract](https://github.com/tesseract-ocr/tesseract) English model (Apache 2.0), read the odometer.
- [Manrope](https://github.com/sharanda/manrope) (SIL Open Font License 1.1).
