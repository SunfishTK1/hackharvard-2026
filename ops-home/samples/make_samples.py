"""Synthetic study and site documents for trying the setup forms.

Writes public/samples/<STUDY>/ in the same layout as the handoff package
(clinical_trial_synthetic_package.zip): Protocol, ICF, Schedule of Activities and
ePRO PDFs for each new study, plus a site roster, a site information sheet and a
site-specific ICF for every site. Everything here is invented.

    python3 -m venv .venv && .venv/bin/pip install reportlab==4.4.4
    .venv/bin/python samples/make_samples.py
"""
import csv
import json
import os
import re

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "samples")
DISCLAIMER = "SYNTHETIC DEMO DOCUMENT - FOR SOFTWARE TESTING/HACKATHON USE ONLY - NOT IRB APPROVED"
HEAD_FILL = colors.Color(0.85098, 0.917647, 0.968627)

STUDIES = [
    {
        "study_id": "STUDY-006",
        "protocol_id": "RSP220-305",
        "title": "A Phase III Study of RSP-220 Inhaler in Adults With Moderate Persistent Asthma",
        "condition": "Moderate Persistent Asthma",
        "phase": "Phase 3",
        "design": "Randomized, double-blind, placebo-controlled, parallel-group",
        "target_enrollment": 210,
        "duration_weeks": 16,
        "arms": ["RSP-220 200 mcg inhaled twice daily", "Placebo inhaler twice daily"],
        "intervention": "RSP-220",
        "protocol_version": "2.3",
        "icf_version": "1.4",
        "soa_version": "1.1",
        "epro_version": "1.2",
        "inclusion": [
            "Age 18-70 years",
            "Physician-diagnosed asthma for at least 12 months",
            "Pre-bronchodilator FEV1 50%-85% of predicted at screening",
            "Able to use a connected peak-flow meter",
        ],
        "exclusion": [
            "Current smoker or smoking history of 10 pack-years or more",
            "Asthma exacerbation requiring hospitalization within 3 months",
            "Pregnancy",
        ],
        "primary": "Change from baseline in pre-bronchodilator FEV1 at Week 16",
        "measures": [
            ["Asthma symptom score", "0-10", "Daily", "Patient message"],
            ["Study inhaler used", "Yes/No", "Twice daily", "Patient message"],
            ["Rescue inhaler puffs", "Count", "Daily", "Patient message"],
            ["Peak expiratory flow", "L/min", "Twice daily", "Connected device"],
            ["Spirometry FEV1", "L", "Weeks 0,4,8,16", "Site visit"],
        ],
        "risks": ["throat irritation", "hoarseness", "headache", "oral thrush",
                  "unknown risks typical of an investigational product"],
        "visits": ["Screening", "Baseline", "Week 2", "Week 4", "Week 8", "Week 12", "Week 16"],
        "sponsor": "Northwind Respiratory (synthetic)",
    },
    {
        "study_id": "STUDY-007",
        "protocol_id": "RA315-204",
        "title": "A Phase II Study of RA-315 in Adults With Active Rheumatoid Arthritis",
        "condition": "Rheumatoid Arthritis",
        "phase": "Phase 2",
        "design": "Randomized, double-blind, placebo-controlled",
        "target_enrollment": 120,
        "duration_weeks": 12,
        "arms": ["RA-315 100 mg subcutaneous once weekly", "Placebo subcutaneous once weekly"],
        "intervention": "RA-315",
        "protocol_version": "1.6",
        "icf_version": "1.2",
        "soa_version": "1.0",
        "epro_version": "1.1",
        "inclusion": [
            "Age 18 years or older",
            "Rheumatoid arthritis diagnosis for at least 6 months",
            "At least 6 swollen joints at screening",
            "Stable methotrexate dose for 8 weeks",
        ],
        "exclusion": [
            "Active or latent tuberculosis",
            "Prior treatment with a biologic in the same class",
            "Pregnancy",
        ],
        "primary": "Proportion of participants achieving ACR20 response at Week 12",
        "measures": [
            ["Joint pain severity", "0-10", "Daily", "Patient message"],
            ["Morning stiffness duration", "Minutes", "Daily", "Patient message"],
            ["Weekly injection given", "Yes/No", "Weekly", "Patient message"],
            ["Injection site reaction", "Yes/No", "Weekly", "Patient questionnaire"],
            ["C-reactive protein", "mg/L", "Weeks 0,4,8,12", "Site laboratory"],
        ],
        "risks": ["injection site reactions", "upper respiratory infections", "headache",
                  "unknown risks typical of an investigational product"],
        "visits": ["Screening", "Baseline", "Week 2", "Week 4", "Week 8", "Week 12"],
        "sponsor": "Calder Immunology (synthetic)",
    },
    {
        "study_id": "STUDY-008",
        "protocol_id": "HFC-RM-02",
        "title": "Remote Monitoring After Heart Failure Hospitalization With the HF-Connect Program",
        "condition": "Heart Failure",
        "phase": "Not Applicable",
        "design": "Randomized, open-label, remote device-enabled study",
        "target_enrollment": 160,
        "duration_weeks": 12,
        "arms": ["HF-Connect remote monitoring", "Standard discharge follow-up"],
        "intervention": "HF-Connect",
        "protocol_version": "1.0",
        "icf_version": "1.0",
        "soa_version": "1.0",
        "epro_version": "1.0",
        "inclusion": [
            "Age 40-85 years",
            "Hospitalized for heart failure within the past 14 days",
            "Home internet or cellular access",
            "Able to stand on the study scale",
        ],
        "exclusion": [
            "Planned cardiac surgery within 12 weeks",
            "Enrolled in hospice care",
        ],
        "primary": "Heart failure readmission or emergency visit by Week 12",
        "measures": [
            ["Body weight", "kg", "Daily", "Connected device"],
            ["Shortness of breath at rest", "Yes/No", "Daily", "Patient message"],
            ["Ankle swelling", "0-10", "Daily", "Patient message"],
            ["Daily steps", "Count", "Daily", "Connected device"],
            ["NT-proBNP", "pg/mL", "Weeks 0,6,12", "Site laboratory"],
        ],
        "risks": ["inconvenience of daily measurements", "privacy risks related to remote monitoring",
                  "possible anxiety from repeated measurements"],
        "visits": ["Screening", "Baseline", "Week 2", "Week 6", "Week 12"],
        "sponsor": "Harborline Cardiology Network (synthetic)",
    },
]

# site_id, study_id, institution, address, city, state, time zone, PI, coordinator, status, local ICF suffix
SITES = [
    ("SITE-006-A", "STUDY-006", "Bayview Pulmonary Research Unit", "220 Longwood Ave", "Boston", "MA",
     "America/New_York", "Dr. Hannah Okafor", "Marcus Bell", "Active", "BOS"),
    ("SITE-006-B", "STUDY-006", "Granite State Lung Center", "41 Elm St", "Manchester", "NH",
     "America/New_York", "Dr. Paul Delgado", "Ivy Thompson", "Active", "MAN"),
    ("SITE-007-A", "STUDY-007", "Charles River Arthritis Clinic", "88 Cambridge St", "Boston", "MA",
     "America/New_York", "Dr. Sofia Marin", "Jamie Fox", "Active", "BOS"),
    ("SITE-007-B", "STUDY-007", "Connecticut Valley Rheumatology", "15 Asylum St", "Hartford", "CT",
     "America/New_York", "Dr. Kenji Watanabe", "Rosa Diaz", "Active", "HAR"),
    ("SITE-008-A", "STUDY-008", "Beacon Heart Failure Program", "300 Fruit St", "Boston", "MA",
     "America/New_York", "Dr. Grace Liu", "Tom Becker", "Active", "BOS"),
    ("SITE-008-B", "STUDY-008", "Narragansett Cardiology Associates", "9 Point St", "Providence", "RI",
     "America/New_York", "Dr. Omar Haddad", "Kira Novak", "Active", "PRO"),
    ("SITE-008-C", "STUDY-008", "Pioneer Valley Heart Institute", "759 Chestnut St", "Springfield", "MA",
     "America/New_York", "Dr. Ellen Brooks", "Dev Malhotra", "Setup", "SPR"),
]

# A third site for a study that already runs, to try adding a site on its own.
EXTRA_SITES = [
    ("SITE-005-C", "STUDY-005", "Seacoast Hypertension Research", "55 Pleasant St", "Portsmouth", "NH",
     "America/New_York", "Dr. Ruth Alvarez", "Ben Carter", "Active", "POR", "1.0",
     "Remote Blood Pressure Monitoring Study in Adults With Hypertension", "BPLINK-HTN-01"),
]

styles = {
    "banner": ParagraphStyle("banner", fontName="Helvetica-Bold", fontSize=16, leading=20, alignment=1),
    "warn": ParagraphStyle("warn", fontName="Helvetica", fontSize=8.5, leading=11, alignment=1,
                           textColor=colors.Color(0.545098, 0, 0)),
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=18, leading=22),
    "meta": ParagraphStyle("meta", fontName="Helvetica", fontSize=9.2, leading=12.5),
    "h": ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=11.5, leading=15, spaceBefore=8, spaceAfter=3),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9.5, leading=12.5),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.5, leading=10.5),
    "cellb": ParagraphStyle("cellb", fontName="Helvetica-Bold", fontSize=8.5, leading=10.5),
}


def esc(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def header(story, banner, title, protocol_id, study_id, version_label=None, version=None):
    story += [Paragraph(banner, styles["banner"]), Paragraph(DISCLAIMER, styles["warn"]), Spacer(1, 6),
              Paragraph(esc(title), styles["title"]), Spacer(1, 2),
              Paragraph(f"<b>Protocol ID:</b> {esc(protocol_id)}&nbsp;&nbsp;&nbsp;&nbsp;<b>Study ID:</b> {study_id}",
                        styles["meta"])]
    if version_label:
        story += [Spacer(1, 4), Paragraph(f"<b>{version_label}</b> {esc(version)}", styles["meta"])]
    story.append(Spacer(1, 8))


def grid(rows, widths, head=True):
    table = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("FONTNAME", (0, 0), (-1, -1), "Helvetica"), ("FONTSIZE", (0, 0), (-1, -1), 8.5)]
    if head:
        style += [("BACKGROUND", (0, 0), (-1, 0), HEAD_FILL), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")]
    table.setStyle(TableStyle(style))
    return table


def para(text, style="cell"):
    return Paragraph(esc(text), styles[style])


def build(path, story, pagesize=letter):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    doc = SimpleDocTemplate(path, pagesize=pagesize, leftMargin=38.4, rightMargin=38.4, topMargin=40,
                            bottomMargin=40, title=os.path.basename(path), author="Synthetic demo",
                            invariant=1)
    doc.build(story)


def measure_prompt(name, response):
    if response == "0-10":
        return f"On a scale from 0 to 10, what was your {name.lower()} today?"
    if response == "Yes/No":
        return f"{name}?"
    if response in ("Count", "Minutes", "Score") or re.fullmatch(r"[A-Za-z/%]+", response):
        return f"Please enter your {name.lower()} ({response})."
    return f"Please report your {name.lower()}."


def protocol(s, folder):
    story = []
    header(story, "SYNTHETIC CLINICAL STUDY PROTOCOL", s["title"], s["protocol_id"], s["study_id"])
    rows = [["Protocol version", s["protocol_version"]], ["Sponsor", s["sponsor"]], ["Phase", s["phase"]],
            ["Condition", s["condition"]], ["Design", s["design"]],
            ["Target enrollment", str(s["target_enrollment"])], ["Duration", f'{s["duration_weeks"]} weeks'],
            ["Primary objective", s["primary"]]]
    story += [grid([[para(k, "cellb"), para(v)] for k, v in rows], [130, 405], head=False), Spacer(1, 8)]
    arms = "; ".join(s["arms"]) + "."
    sections = [
        ("1. Study Synopsis",
         f"This synthetic protocol evaluates {s['intervention']} in participants with {s['condition']}. The study uses a "
         f"{s['design'][0].lower() + s['design'][1:]} design and plans to enroll approximately {s['target_enrollment']} "
         "participants across multiple sites."),
        ("2. Objectives and Endpoints",
         f"Primary endpoint: {s['primary']}. Secondary objectives include participant safety, adherence, feasibility of "
         "remote data collection, and descriptive changes in study-specific patient-reported measures."),
        ("3. Study Arms", arms),
    ]
    for head, text in sections:
        story += [Paragraph(head, styles["h"]), Paragraph(esc(text), styles["body"])]
    story.append(Paragraph("4. Inclusion Criteria", styles["h"]))
    story += [Paragraph("- " + esc(x), styles["body"]) for x in s["inclusion"]]
    story.append(Paragraph("5. Exclusion Criteria", styles["h"]))
    story += [Paragraph("- " + esc(x), styles["body"]) for x in s["exclusion"]]
    story += [Paragraph("6. Study Procedures", styles["h"]), Paragraph(
        "Participants complete screening, informed consent, baseline assessments, scheduled study visits, and remote or "
        "site-based assessments according to the Schedule of Activities. Patient-reported measures may be collected "
        "through a secure messaging interface or linked web form.", styles["body"])]
    story.append(Paragraph("7. Study Measurements", styles["h"]))
    story += [Paragraph(f"- {esc(m[0])}: {esc(m[2])} ({esc(m[3])})", styles["body"]) for m in s["measures"]]
    for head, text in [
        ("8. Safety Monitoring", "Study staff review predefined safety and completeness signals. Automated software may "
         "flag missing or unusual values for human review but does not independently make medical decisions."),
        ("9. Data Management", "Each participant is assigned a study-specific participant ID. Identifiable contact "
         "information is stored separately from the analysis dataset. Source responses, parsed values, timestamps, "
         "document versions, and audit events are retained."),
        ("10. Statistical Overview", "The primary analysis will summarize the primary endpoint according to the "
         "prespecified analysis population. Descriptive statistics will be used for adherence, missingness, "
         "participant-reported measures, and operational monitoring."),
    ]:
        story += [Paragraph(head, styles["h"]), Paragraph(esc(text), styles["body"])]
    build(os.path.join(folder, "Protocol.pdf"), story)


def icf_story(s, version, site=None):
    story = []
    banner = "SYNTHETIC INFORMED CONSENT FORM" + (" - SITE VERSION" if site else "")
    header(story, banner, s["title"], s["protocol_id"], s["study_id"], "ICF version:", version)
    if site:
        rows = [["Site ID", site["site_id"]], ["Institution", site["institution"]],
                ["Principal investigator", site["pi"]], ["Study coordinator", site["coordinator"]],
                ["Coordinator phone", site["phone"]], ["Based on master ICF version", s["icf_version"]]]
        story += [grid([[para(k, "cellb"), para(v)] for k, v in rows], [150, 385], head=False), Spacer(1, 6)]
    measures = ", ".join(m[0] for m in s["measures"])
    risks = ", ".join(s["risks"])
    contact = (f"Questions about this study can be directed to {site['coordinator']} at {site['phone']}, or to the "
               f"study investigator, {site['pi']}." if site else
               "The site-specific consent form would list the study investigator, coordinator, participant-rights "
               "contact, and emergency instructions.")
    qa = [
        ("Why am I being asked to participate?",
         f"You are being invited because you may meet the eligibility requirements for a research study involving "
         f"{s['condition']}."),
        ("What is the purpose of the study?",
         f"The study is evaluating {s['intervention']}. The study is expected to last approximately "
         f"{s['duration_weeks']} weeks for each participant."),
        ("What will happen if I participate?",
         "You will complete study procedures listed in the approved schedule. Some activities occur at the study site "
         "and some may occur remotely. You may receive secure messages containing reminders, study questions, or links "
         "to approved study forms."),
        ("What information will I provide?", f"The study may collect: {measures}."),
        ("What are the possible risks?",
         f"This synthetic document is not a real risk disclosure. Example categories for demonstration include {risks}. "
         "A real ICF would contain the exact IRB-approved risk language."),
        ("Are there benefits?", "You may or may not receive direct benefit. The information may help researchers learn "
         "about the condition or intervention."),
        ("Do I have to participate?", "No. Participation is voluntary. You may decline or withdraw according to the "
         "procedures described by the study team."),
        ("How will my information be protected?", "Study records will use a participant identifier where possible. "
         "Contact information used for messaging is stored separately from research analysis data. A real study may "
         "use a separate HIPAA/privacy authorization."),
        ("Who can I contact?", contact),
        ("Electronic communication", "If you agree to receive electronic study communications, the study may send "
         "approved reminders and study materials to your registered contact method. Urgent medical concerns should "
         "follow the study's emergency instructions rather than rely on automated messaging."),
    ]
    for q, a in qa:
        story += [Paragraph(esc(q), styles["h"]), Paragraph(esc(a), styles["body"])]
    story += [Paragraph("CONSENT SIGNATURES", styles["h"]), Paragraph(
        "By signing, I confirm that I had the opportunity to review the study information and ask questions. This "
        "signature block is synthetic and for product testing only.", styles["body"]), Spacer(1, 6)]
    sign = [[para(x, "cellb"), para("____________________________")] for x in
            ["Participant name", "Participant signature", "Date/time", "Person obtaining consent", "Signature/date"]]
    story.append(grid(sign, [170, 300], head=False))
    return story


def schedule(s, folder):
    story = []
    header(story, "SYNTHETIC SCHEDULE OF ACTIVITIES", s["title"], s["protocol_id"], s["study_id"], "Version:",
           s["soa_version"])
    visits = s["visits"]
    weeks = {v: int(v.split()[1]) for v in visits if v.startswith("Week")}

    def marks(name, freq, source):
        if name == "Eligibility review" or name == "Informed consent":
            return ["X" if v == "Screening" else "" for v in visits]
        if name == "Medical history":
            return ["X" if v in ("Screening", "Baseline") else "" for v in visits]
        if name == "Randomization / arm assignment":
            return ["X" if v == "Baseline" else "" for v in visits]
        if name in ("Adverse event review",):
            return ["" if v == "Screening" else "X" for v in visits]
        if name == "Concomitant medication review":
            return ["X" for _ in visits]
        if freq.startswith("Weeks"):
            due = {int(x) for x in freq.split(" ", 1)[1].split(",")}
            return ["X" if (v == "Baseline" and 0 in due) or weeks.get(v) in due else "" for v in visits]
        return ["" if v == "Screening" else "Remote*" for v in visits]

    rows = [["Activity"] + visits]
    for name in ["Eligibility review", "Informed consent", "Medical history", "Randomization / arm assignment"]:
        rows.append([name] + marks(name, "", ""))
    for m in s["measures"]:
        rows.append([m[0]] + marks(m[0], m[2], m[3]))
    for name in ["Adverse event review", "Concomitant medication review"]:
        rows.append([name] + marks(name, "", ""))
    width = 715 - 160
    table = Table(rows, colWidths=[160] + [width / len(visits)] * len(visits))
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), HEAD_FILL),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.3), ("ALIGN", (1, 0), (-1, -1), "CENTER")]))
    story += [table, Spacer(1, 8), Paragraph(
        "* Remote indicates an activity may be completed between formal visits according to the approved protocol and "
        "study workflow.", styles["body"])]
    build(os.path.join(folder, "Schedule_of_Activities.pdf"), story, landscape(letter))


def epro(s, folder):
    story = []
    header(story, "SYNTHETIC PATIENT QUESTIONNAIRE / ePRO SPECIFICATION", s["title"], s["protocol_id"], s["study_id"],
           "Version:", s["epro_version"])
    story += [Paragraph("These items are synthetic examples used to demonstrate secure-message data collection and do "
                        "not represent a validated clinical instrument.", styles["body"]), Spacer(1, 8)]
    rows = [[para(x, "cellb") for x in ["Field ID", "Patient-facing prompt", "Response type", "Frequency", "Source"]]]
    for i, m in enumerate(s["measures"], 1):
        rows.append([para(f"Q{i:02d}"), para(measure_prompt(m[0], m[1])), para(m[1]), para(m[2]), para(m[3])])
    story += [grid(rows, [50, 220, 85, 85, 95]), Spacer(1, 10), Paragraph("Example messaging behavior", styles["h"]),
              Paragraph("A participant in consent_pending status receives the approved eConsent workflow. Once "
                        "enrolled/active, the messaging service sends only questions that are due for that participant "
                        "and study. Missing responses can trigger reminders, while predefined study rules can create "
                        "staff-review alerts.", styles["body"])]
    build(os.path.join(folder, "Patient_Questionnaire_ePRO.pdf"), story)


def site_files(s, site, folder):
    """A site information sheet and the site's own ICF."""
    story = []
    header(story, "SYNTHETIC SITE INFORMATION SHEET", s["title"], s["protocol_id"], s["study_id"])
    rows = [["Site ID", site["site_id"]], ["Institution", site["institution"]], ["Street address", site["address"]],
            ["City", site["city"]], ["State", site["state"]], ["Country", "US"], ["Time zone", site["tz"]],
            ["Principal investigator", site["pi"]], ["Study coordinator", site["coordinator"]],
            ["Coordinator email", site["email"]], ["Coordinator phone", site["phone"]],
            ["Site status", site["status"]], ["Local ICF version", site["icf"]]]
    story += [grid([[para(k, "cellb"), para(v)] for k, v in rows], [150, 385], head=False), Spacer(1, 10),
              Paragraph("Site activation checklist", styles["h"])]
    checks = [["IRB approval of local ICF", "Complete"], ["Investigator agreement signed", "Complete"],
              ["Coordinator trained on secure messaging", "Complete" if site["status"] == "Active" else "Scheduled"],
              ["Site initiation visit", "Complete" if site["status"] == "Active" else "Scheduled"]]
    story.append(grid([[para("Item", "cellb"), para("Status", "cellb")]] + [[para(a), para(b)] for a, b in checks],
                      [300, 235]))
    build(os.path.join(folder, f"Site_Information_{site['site_id']}.pdf"), story)
    build(os.path.join(folder, f"ICF_{site['icf']}_{site['site_id']}.pdf"), icf_story(s, site["icf"], site))


def site_record(row, icf_version):
    site_id, study_id, inst, address, city, state, tz, pi, coord, status, suffix = row[:11]
    n = int(re.sub(r"\D", "", site_id)) % 100
    slug = re.sub(r"[^a-z]+", ".", coord.lower())
    return {"site_id": site_id, "study_id": study_id, "institution": inst, "address": address, "city": city,
            "state": state, "tz": tz, "pi": pi, "coordinator": coord, "status": status,
            "icf": f"{icf_version}-{suffix}", "email": f"{slug}@example.org",
            "phone": f"+1-617-555-{2000 + n * 10 + ord(site_id[-1]) - 64:04d}"}


def roster(path, sites):
    with open(path, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["site_id", "study_id", "institution", "city", "state", "principal_investigator", "coordinator",
                    "site_status", "local_icf_version"])
        for x in sites:
            w.writerow([x["site_id"], x["study_id"], x["institution"], x["city"], x["state"], x["pi"],
                        x["coordinator"], x["status"], x["icf"]])


def main():
    expected = {"warning": "All data and documents are synthetic.", "studies": [], "sites": []}
    for s in STUDIES:
        folder = os.path.join(OUT, s["study_id"])
        protocol(s, folder)
        build(os.path.join(folder, "ICF.pdf"), icf_story(s, s["icf_version"]))
        schedule(s, folder)
        epro(s, folder)
        sites = [site_record(r, s["icf_version"]) for r in SITES if r[1] == s["study_id"]]
        site_dir = os.path.join(folder, "sites")
        for site in sites:
            site_files(s, site, site_dir)
        roster(os.path.join(site_dir, "Site_Roster.csv"), sites)
        expected["studies"].append({k: v for k, v in s.items() if k not in ("visits",)} | {"visits": s["visits"]})
        expected["sites"] += sites
    for row in EXTRA_SITES:
        icf_version, title, protocol_id = row[11], row[12], row[13]
        s = {"study_id": row[1], "title": title, "protocol_id": protocol_id, "icf_version": icf_version,
             "condition": "Hypertension", "intervention": "BP-Link", "duration_weeks": 12,
             "measures": [["Systolic blood pressure"], ["Diastolic blood pressure"], ["Pulse"], ["BP medication taken"],
                          ["Symptoms"]],
             "risks": ["minor discomfort from cuff inflation", "privacy risks related to remote monitoring",
                       "possible anxiety from repeated measurements"]}
        site = site_record(row, icf_version)
        site_dir = os.path.join(OUT, row[1], "sites")
        site_files(s, site, site_dir)
        roster(os.path.join(site_dir, "Site_Roster.csv"), [site])
        expected["sites"].append(site)
    with open(os.path.join(OUT, "expected.json"), "w") as f:
        json.dump(expected, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
