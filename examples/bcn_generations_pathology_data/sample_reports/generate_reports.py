"""Generate 10 synthetic benign breast disease pathology reports as multi-page TIF images.

Directory structure:
    BBD_Path_Reports/<yearmonth>/<mm>/<document_id>.<pagenumber>    (no file extension)

Metadata CSV columns:
    TCode, yearmonth, mm, CB_DOCID, CB_PAGES
"""

from __future__ import annotations

import csv
import os
import random
import textwrap
from datetime import date, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------- config ----------

ROOT = Path(__file__).parent
OUT_ROOT = ROOT / "BBD_Path_Reports"
METADATA_CSV = ROOT / "metadata.csv"
N_REPORTS = 10
SEED = 20260706

# 8.5x11 at 200 DPI
PAGE_W, PAGE_H = 1700, 2200
DPI = 200
MARGIN_X = 150
MARGIN_TOP = 150
LINE_H = 30
BODY_WRAP = 90  # chars per wrapped line at body font size

# ---------- content pools ----------

INSTITUTIONS = [
    ("Mercy General Hospital", "Department of Pathology", "1200 Elm Street, Springfield, IL 62704"),
    ("St. Vincent Medical Center", "Anatomic Pathology Division", "445 Oakwood Ave, Portland, OR 97209"),
    ("Northshore Regional Health", "Surgical Pathology", "88 Lakeview Drive, Evanston, IL 60201"),
    ("Riverbend Community Hospital", "Department of Pathology & Laboratory Medicine", "3021 River Road, Boise, ID 83702"),
    ("Cedar Ridge Medical Center", "Pathology Services", "610 Cedar Ridge Blvd, Nashville, TN 37209"),
    ("Bayside University Hospital", "Division of Anatomic Pathology", "77 Bayside Avenue, Providence, RI 02903"),
]

PATHOLOGISTS = [
    ("Margaret L. Whitfield, M.D.", "Board Certified, Anatomic & Clinical Pathology"),
    ("David S. Kaminski, M.D., Ph.D.", "Board Certified, Anatomic Pathology"),
    ("Priya R. Ananthakrishnan, M.D.", "Board Certified, Anatomic & Clinical Pathology"),
    ("Jonathan T. Reeves, D.O.", "Board Certified, Anatomic Pathology"),
    ("Elena V. Marchetti, M.D.", "Board Certified, Anatomic & Clinical Pathology"),
    ("Harold W. Simpson, M.D.", "Board Certified, Anatomic Pathology"),
]

REFERRING_CLINICIANS = [
    "Dr. R. Patel, Breast Surgery",
    "Dr. M. Fitzgerald, General Surgery",
    "Dr. L. Nguyen, Breast Health Clinic",
    "Dr. A. Bergstrom, Breast Surgery",
    "Dr. S. Okafor, Surgical Oncology",
    "Dr. J. Halvorsen, Breast Surgery",
]

FEMALE_FIRST = ["Mary", "Linda", "Patricia", "Susan", "Karen", "Nancy", "Betty", "Helen", "Sandra", "Donna",
                "Carol", "Ruth", "Sharon", "Michelle", "Laura", "Sarah", "Kimberly", "Deborah", "Jessica", "Amanda"]
LAST_NAMES = ["Anderson", "Thompson", "Martinez", "Robinson", "Clark", "Rodriguez", "Lewis", "Lee", "Walker",
              "Hall", "Allen", "Young", "Hernandez", "King", "Wright", "Lopez", "Hill", "Scott", "Green", "Adams",
              "Baker", "Nelson", "Carter", "Mitchell", "Perez", "Roberts", "Turner", "Phillips", "Campbell", "Parker"]

SPECIMEN_TYPES = [
    ("Left breast, 2 o'clock, core needle biopsy", "core needle biopsy", "left"),
    ("Right breast, 10 o'clock, core needle biopsy", "core needle biopsy", "right"),
    ("Left breast, upper outer quadrant, excisional biopsy", "excisional biopsy", "left"),
    ("Right breast, retroareolar, ultrasound-guided core biopsy", "ultrasound-guided core biopsy", "right"),
    ("Left breast, 3 o'clock, stereotactic core biopsy", "stereotactic core biopsy", "left"),
    ("Right breast, upper inner quadrant, lumpectomy", "lumpectomy", "right"),
    ("Left breast, lower outer quadrant, needle localized excisional biopsy", "needle localized excisional biopsy", "left"),
    ("Right breast, 6 o'clock, core needle biopsy", "core needle biopsy", "right"),
]

CLINICAL_HISTORIES = [
    "{age}-year-old female with mammographic calcifications, BIRADS 4.",
    "{age}-year-old female with palpable mass on self-examination.",
    "{age}-year-old female with focal asymmetry on screening mammogram.",
    "{age}-year-old female with dense nodularity on physical examination; ultrasound-guided biopsy performed.",
    "{age}-year-old female with new solid mass on ultrasound, BIRADS 4A.",
    "{age}-year-old female presenting with nipple discharge and retroareolar density.",
    "{age}-year-old female with architectural distortion identified on tomosynthesis.",
    "{age}-year-old female with clustered microcalcifications noted on annual screening.",
]

BBD_DIAGNOSES = [
    {
        "primary": "Fibrocystic changes",
        "micro": (
            "Sections demonstrate benign breast parenchyma with prominent fibrocystic changes, including cyst "
            "formation lined by attenuated epithelium and focal apocrine metaplasia. Stromal fibrosis is present. "
            "No atypical epithelial proliferation, in situ carcinoma, or invasive malignancy is identified."
        ),
        "gross": (
            "The specimen consists of {n} tan-white fibrofatty tissue cores measuring in aggregate {size} cm. "
            "The cores are submitted entirely in one cassette."
        ),
        "components": ["Cyst formation with apocrine metaplasia", "Stromal fibrosis", "Usual ductal hyperplasia, mild"],
    },
    {
        "primary": "Fibroadenoma",
        "micro": (
            "The lesion demonstrates the characteristic biphasic proliferation of a fibroadenoma with an "
            "intracanalicular growth pattern. Ductal structures are compressed by a bland, cellular stroma. "
            "The epithelial component is two-cell-layered without atypia. No phyllodes features, in situ, or "
            "invasive carcinoma is identified. Margins, where evaluable, are unremarkable."
        ),
        "gross": (
            "Received in formalin is a well-circumscribed, rubbery, tan-white nodule measuring {size} cm. "
            "Cut surface is homogeneous with a whorled appearance. The specimen is serially sectioned and "
            "submitted in cassettes A1-A{n}."
        ),
        "components": ["Biphasic epithelial-stromal proliferation", "Intracanalicular pattern", "No atypia"],
    },
    {
        "primary": "Sclerosing adenosis",
        "micro": (
            "The biopsy shows a lobulocentric proliferation of compressed acinar structures set in a dense "
            "sclerotic stroma, consistent with sclerosing adenosis. Myoepithelial cells are preserved, confirmed "
            "on immunohistochemistry (p63 and calponin, positive). No atypical ductal hyperplasia, in situ, or "
            "invasive carcinoma is identified."
        ),
        "gross": (
            "The specimen consists of {n} tan-white core biopsies measuring up to {size} cm in aggregate, "
            "submitted entirely in a single cassette."
        ),
        "components": ["Lobulocentric compressed acini", "Preserved myoepithelium (p63+, calponin+)", "Dense sclerotic stroma"],
    },
    {
        "primary": "Intraductal papilloma",
        "micro": (
            "The lesion is a well-defined intraductal proliferation with arborizing fibrovascular cores lined by "
            "a bilayered epithelium, diagnostic of an intraductal papilloma. No atypia, atypical papillary "
            "hyperplasia, papillary DCIS, or invasive carcinoma is identified. Myoepithelial layer is intact by "
            "immunohistochemistry (p63 positive)."
        ),
        "gross": (
            "Received are {n} tan-pink core needle biopsies measuring in aggregate {size} cm. Specimen is "
            "entirely submitted."
        ),
        "components": ["Arborizing fibrovascular cores", "Intact myoepithelial layer (p63+)", "No atypia"],
    },
    {
        "primary": "Usual ductal hyperplasia",
        "micro": (
            "Sections demonstrate benign breast tissue with foci of usual ductal hyperplasia characterized by a "
            "heterogeneous epithelial proliferation with peripheral, slit-like secondary lumina and streaming "
            "nuclei. Immunohistochemistry for CK5/6 shows a mosaic staining pattern, supporting the benign "
            "nature of the proliferation. No atypia, in situ, or invasive carcinoma is identified."
        ),
        "gross": (
            "The specimen consists of {n} tan-white fibrofatty cores measuring in aggregate {size} cm, "
            "submitted entirely."
        ),
        "components": ["Heterogeneous proliferation", "Peripheral slit-like lumina", "CK5/6 mosaic pattern"],
    },
    {
        "primary": "Complex fibroadenoma with fibrocystic changes",
        "micro": (
            "The lesion demonstrates a fibroadenoma with complex features, including cyst formation greater "
            "than 3 mm, sclerosing adenosis, and epithelial calcifications. The adjacent breast parenchyma "
            "shows fibrocystic changes with apocrine metaplasia. Myoepithelial cells are preserved throughout. "
            "No atypical hyperplasia, in situ, or invasive carcinoma is identified."
        ),
        "gross": (
            "Received is a well-circumscribed nodule measuring {size} cm with a tan-white cut surface. "
            "Multiple small cystic spaces are noted. Serially sectioned and submitted in {n} cassettes."
        ),
        "components": ["Cysts >3 mm", "Sclerosing adenosis", "Epithelial calcifications", "Apocrine metaplasia"],
    },
    {
        "primary": "Columnar cell change with cyst formation",
        "micro": (
            "The specimen shows columnar cell change involving terminal duct lobular units, with mildly "
            "dilated acini lined by uniform columnar cells. Apical snouts and intraluminal secretions with "
            "microcalcifications are present. No cytologic or architectural atypia. No flat epithelial "
            "atypia, ADH, in situ, or invasive carcinoma is identified."
        ),
        "gross": (
            "The specimen consists of {n} core biopsies measuring up to {size} cm in aggregate, submitted "
            "entirely in one cassette for microscopic examination."
        ),
        "components": ["Columnar cell change (no atypia)", "Apical snouts", "Luminal microcalcifications"],
    },
    {
        "primary": "Radial scar / complex sclerosing lesion",
        "micro": (
            "The lesion demonstrates a central fibroelastotic core with entrapped ductal structures radiating "
            "outward, associated with adenosis and usual ductal hyperplasia at the periphery. Myoepithelial "
            "cells are preserved on p63 and calponin immunostains. No atypia, in situ, or invasive carcinoma "
            "is identified. Given the constellation of features, correlation with imaging and further excision "
            "may be considered per multidisciplinary recommendation."
        ),
        "gross": (
            "Received is a firm, irregular tan-white lesion measuring {size} cm with a stellate cut surface. "
            "Serially sectioned and entirely submitted in {n} cassettes."
        ),
        "components": ["Fibroelastotic core", "Radiating entrapped ducts", "Peripheral adenosis and UDH",
                       "Intact myoepithelium (p63+, calponin+)"],
    },
]

ADDENDA = [
    ("Immunohistochemistry", (
        "Immunohistochemical stains were performed on the block of interest. p63 highlights an intact "
        "myoepithelial layer surrounding the lesional ductal structures. Calponin shows a similarly "
        "preserved distribution. CK5/6 demonstrates a mosaic pattern in areas of epithelial proliferation, "
        "consistent with usual ductal hyperplasia. Appropriate positive and negative controls stained as "
        "expected."
    )),
    ("Correlation", (
        "The pathologic findings are concordant with the imaging findings described in the clinical history "
        "and are considered adequately representative of the target lesion. Continued routine radiologic "
        "follow-up is recommended per clinician judgment."
    )),
    ("Comment", (
        "The findings are entirely benign. There is no evidence of atypical hyperplasia (ADH or ALH), "
        "lobular carcinoma in situ, ductal carcinoma in situ, or invasive carcinoma. The lesion does not "
        "carry an elevated short-term risk warranting escalated surveillance beyond standard-of-care "
        "screening."
    )),
]

# ---------- helpers ----------

def rand_date_2010_2020(rng: random.Random) -> date:
    start = date(2010, 1, 1)
    end = date(2020, 12, 31)
    delta = (end - start).days
    return start + timedelta(days=rng.randint(0, delta))


def rand_tcode(rng: random.Random) -> str:
    return f"T{rng.randint(100000, 999999)}"


def rand_docid(rng: random.Random) -> str:
    return f"{rng.randint(10_000_000, 99_999_999)}"


def rand_accession(rng: random.Random, yr: int) -> str:
    return f"S{yr}-{rng.randint(10000, 99999):05d}"


def pick_pages(rng: random.Random) -> int:
    r = rng.random()
    if r < 0.65:
        return 1
    if r < 0.90:
        return 2
    return 3


def wrap_paragraph(text: str, width: int = BODY_WRAP) -> list[str]:
    return textwrap.wrap(text, width=width) or [""]


# ---------- report content ----------

def build_report(rng: random.Random, tcode: str, docid: str, accession: str, coll_date: date,
                 report_date: date, n_pages: int) -> list[list[str]]:
    """Build the full report body as a list of lines, then paginate into `n_pages` pages."""
    inst_name, inst_dept, inst_addr = rng.choice(INSTITUTIONS)
    path_name, path_cert = rng.choice(PATHOLOGISTS)
    referring = rng.choice(REFERRING_CLINICIANS)

    patient_name = f"{rng.choice(FEMALE_FIRST)} {rng.choice(LAST_NAMES)}"
    mrn = f"MRN {rng.randint(1_000_000, 9_999_999)}"
    dob_year = report_date.year - rng.randint(38, 72)
    dob = date(dob_year, rng.randint(1, 12), rng.randint(1, 28))
    age = report_date.year - dob.year

    spec_desc, spec_type, laterality = rng.choice(SPECIMEN_TYPES)
    dx = rng.choice(BBD_DIAGNOSES)
    n_cores = rng.randint(2, 6)
    aggregate_cm = round(rng.uniform(0.8, 3.4), 1)

    clin_hist = rng.choice(CLINICAL_HISTORIES).format(age=age)
    gross = dx["gross"].format(n=n_cores, size=aggregate_cm)

    lines: list[str] = []

    # --- header block ---
    lines.append(inst_name.upper())
    lines.append(inst_dept)
    lines.append(inst_addr)
    lines.append("")
    lines.append("SURGICAL PATHOLOGY REPORT")
    lines.append("=" * 70)
    lines.append("")

    # --- patient / accession block ---
    lines.append(f"Patient Name:        {patient_name}")
    lines.append(f"{mrn}")
    lines.append(f"Date of Birth:       {dob.isoformat()}   (Age: {age})")
    lines.append(f"Sex:                 Female")
    lines.append(f"Accession No:        {accession}")
    lines.append(f"Case ID:             {docid}")
    lines.append(f"Participant ID:      {tcode}")
    lines.append(f"Date Collected:      {coll_date.isoformat()}")
    lines.append(f"Date Received:       {(coll_date + timedelta(days=rng.randint(0, 2))).isoformat()}")
    lines.append(f"Date Reported:       {report_date.isoformat()}")
    lines.append(f"Referring Physician: {referring}")
    lines.append("")
    lines.append("-" * 70)

    # --- specimen ---
    lines.append("SPECIMEN")
    lines.append("-" * 70)
    for wl in wrap_paragraph(f"A. {spec_desc}"):
        lines.append(wl)
    lines.append("")

    # --- clinical history ---
    lines.append("CLINICAL HISTORY")
    lines.append("-" * 70)
    for wl in wrap_paragraph(clin_hist):
        lines.append(wl)
    lines.append("")

    # --- final diagnosis ---
    lines.append("FINAL DIAGNOSIS")
    lines.append("-" * 70)
    lines.append(f"A. Breast, {laterality}, {spec_type}:")
    lines.append(f"   -- {dx['primary']}.")
    for comp in dx["components"]:
        lines.append(f"   -- {comp}.")
    lines.append("   -- Negative for atypia, in situ carcinoma, and invasive carcinoma.")
    lines.append("")

    # --- gross description ---
    lines.append("GROSS DESCRIPTION")
    lines.append("-" * 70)
    for wl in wrap_paragraph(gross):
        lines.append(wl)
    lines.append("")

    # --- microscopic description ---
    lines.append("MICROSCOPIC DESCRIPTION")
    lines.append("-" * 70)
    for wl in wrap_paragraph(dx["micro"]):
        lines.append(wl)
    lines.append("")

    # --- optional addenda for longer reports ---
    if n_pages >= 2:
        for title, body in ADDENDA[: 2 if n_pages == 2 else 3]:
            lines.append(title.upper())
            lines.append("-" * 70)
            for wl in wrap_paragraph(body):
                lines.append(wl)
            lines.append("")

        # A synoptic-style summary block
        lines.append("SYNOPTIC SUMMARY")
        lines.append("-" * 70)
        lines.append(f"  Procedure:            {spec_type.title()}")
        lines.append(f"  Laterality:           {laterality.title()}")
        lines.append(f"  Number of cores:      {n_cores}")
        lines.append(f"  Aggregate size:       {aggregate_cm} cm")
        lines.append(f"  Primary diagnosis:    {dx['primary']}")
        lines.append(f"  Atypia:               Absent")
        lines.append(f"  In situ carcinoma:    Absent")
        lines.append(f"  Invasive carcinoma:   Absent")
        lines.append("")

    if n_pages >= 3:
        lines.append("ADDITIONAL NOTES")
        lines.append("-" * 70)
        extra = (
            "The case was reviewed at the departmental breast pathology consensus conference on "
            f"{(report_date + timedelta(days=rng.randint(1, 4))).isoformat()}. Consensus was reached that the "
            "findings represent a benign process without features that would prompt an upgrade recommendation. "
            "Radiologic-pathologic correlation was performed with the referring radiologist, and the biopsy "
            "sample is considered representative of the imaged target. Recommendation is for return to routine "
            "screening intervals per the referring clinician's discretion. If new or discordant imaging findings "
            "emerge, re-biopsy or excisional sampling should be reconsidered."
        )
        for wl in wrap_paragraph(extra):
            lines.append(wl)
        lines.append("")

        lines.append("SPECIMEN PROCESSING")
        lines.append("-" * 70)
        processing = (
            "The specimen was fixed in 10% neutral buffered formalin for a minimum of 6 hours prior to "
            "grossing. Tissue was processed on an overnight processor, embedded in paraffin, sectioned at "
            "4 microns, and stained with hematoxylin and eosin. Additional levels and immunohistochemical "
            "stains were performed as noted above. Positive and negative controls were included with each "
            "immunohistochemical stain and demonstrated appropriate reactivity."
        )
        for wl in wrap_paragraph(processing):
            lines.append(wl)
        lines.append("")

    # --- sign-off (last page) ---
    lines.append("")
    lines.append("Electronically signed by:")
    lines.append(f"    {path_name}")
    lines.append(f"    {path_cert}")
    lines.append(f"    {inst_dept}, {inst_name}")
    lines.append(f"    Signed: {report_date.isoformat()}")
    lines.append("")
    lines.append("*** END OF REPORT ***")

    # --- paginate ---
    # Reserve room for a footer line; target ~62 body lines per page.
    lines_per_page = 62
    pages: list[list[str]] = []
    for i in range(n_pages):
        chunk = lines[i * lines_per_page:(i + 1) * lines_per_page]
        pages.append(chunk)

    # If we generated fewer non-empty chunks than requested, pad by shifting content
    # so the last page still has the sign-off.
    while len(pages) < n_pages:
        pages.append([])

    # Trim to n_pages
    pages = pages[:n_pages]

    # If content spilled beyond the last page, cram tail into the last page.
    consumed = n_pages * lines_per_page
    if consumed < len(lines):
        pages[-1] = pages[-1] + lines[consumed:]

    return pages


# ---------- rendering ----------

def _load_fonts() -> tuple[ImageFont.ImageFont, ImageFont.ImageFont, ImageFont.ImageFont]:
    # Try a monospace-ish font available on Windows; fall back to default.
    candidates = [
        "consola.ttf",  # Consolas
        "cour.ttf",     # Courier New
        "arial.ttf",
    ]
    body = title = small = None
    for name in candidates:
        try:
            body = ImageFont.truetype(name, 22)
            title = ImageFont.truetype(name, 22)
            small = ImageFont.truetype(name, 18)
            break
        except OSError:
            continue
    if body is None:
        body = title = small = ImageFont.load_default()
    return title, body, small


def render_page(lines: list[str], page_num: int, total_pages: int, docid: str,
                accession: str) -> Image.Image:
    img = Image.new("L", (PAGE_W, PAGE_H), color=255)
    draw = ImageDraw.Draw(img)
    _title, body, small = _load_fonts()

    y = MARGIN_TOP
    for line in lines:
        draw.text((MARGIN_X, y), line, fill=30, font=body)
        y += LINE_H
        if y > PAGE_H - 180:
            break

    # Footer
    footer_y = PAGE_H - 100
    draw.line([(MARGIN_X, footer_y - 10), (PAGE_W - MARGIN_X, footer_y - 10)], fill=120, width=1)
    footer_left = f"Accession: {accession}   Case ID: {docid}"
    footer_right = f"Page {page_num} of {total_pages}"
    draw.text((MARGIN_X, footer_y), footer_left, fill=90, font=small)
    # right-align
    right_bbox = draw.textbbox((0, 0), footer_right, font=small)
    right_w = right_bbox[2] - right_bbox[0]
    draw.text((PAGE_W - MARGIN_X - right_w, footer_y), footer_right, fill=90, font=small)

    return img


# ---------- main ----------

def main() -> None:
    rng = random.Random(SEED)

    # 10 reports across 7 unique patients: 3 patients with 2 reports each (6),
    # plus 4 patients with 1 report each (4).
    unique_tcodes: list[str] = []
    while len(set(unique_tcodes)) < 7:
        unique_tcodes = [rand_tcode(rng) for _ in range(7)]
    tcode_assignments = (
        [unique_tcodes[0]] * 2 +
        [unique_tcodes[1]] * 2 +
        [unique_tcodes[2]] * 2 +
        unique_tcodes[3:]  # 4 more, 1 each
    )
    assert len(tcode_assignments) == 10, len(tcode_assignments)
    rng.shuffle(tcode_assignments)

    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    metadata_rows: list[dict[str, str]] = []

    for idx in range(N_REPORTS):
        tcode = tcode_assignments[idx]
        docid = rand_docid(rng)
        coll_date = rand_date_2010_2020(rng)
        report_date = coll_date + timedelta(days=rng.randint(1, 5))
        yearmonth = f"{report_date.year}{report_date.month:02d}"
        mm = f"{rng.randint(0, 16):02d}"
        n_pages = pick_pages(rng)
        accession = rand_accession(rng, report_date.year)

        pages = build_report(rng, tcode, docid, accession, coll_date, report_date, n_pages)

        page_dir = OUT_ROOT / yearmonth / mm
        page_dir.mkdir(parents=True, exist_ok=True)

        for i, page_lines in enumerate(pages, start=1):
            img = render_page(page_lines, i, n_pages, docid, accession)
            out_path = page_dir / f"{docid}.{i:03d}"
            # Save as TIF with no extension
            img.save(out_path, format="TIFF", compression="tiff_lzw", dpi=(DPI, DPI))

        metadata_rows.append({
            "TCode": tcode,
            "yearmonth": yearmonth,
            "mm": mm,
            "CB_DOCID": docid,
            "CB_PAGES": str(n_pages),
        })

    with METADATA_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["TCode", "yearmonth", "mm", "CB_DOCID", "CB_PAGES"])
        writer.writeheader()
        writer.writerows(metadata_rows)

    total_pages = sum(int(r["CB_PAGES"]) for r in metadata_rows)
    print(f"Generated {N_REPORTS} reports, {total_pages} total pages.")
    print(f"Output: {OUT_ROOT}")
    print(f"Metadata: {METADATA_CSV}")
    unique_patients = len({r["TCode"] for r in metadata_rows})
    print(f"Unique participants: {unique_patients}")
    print(f"Page distribution: "
          f"1p={sum(1 for r in metadata_rows if r['CB_PAGES'] == '1')}, "
          f"2p={sum(1 for r in metadata_rows if r['CB_PAGES'] == '2')}, "
          f"3p={sum(1 for r in metadata_rows if r['CB_PAGES'] == '3')}")


if __name__ == "__main__":
    main()
