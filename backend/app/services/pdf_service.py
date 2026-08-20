"""
pdf_service.py — Generate a professional PDF report for a meeting.

Uses ReportLab's platypus (high-level layout) API to build a clean,
multi-section PDF document. The PDF is generated from the currently
saved meeting data — respecting any manual edits the user made.

ReportLab concepts used here:
- SimpleDocTemplate: the overall PDF canvas and page settings
- Paragraph: a block of styled text
- Spacer: whitespace between sections
- Table: the action items table with borders/colors
- HRFlowable: a horizontal rule (divider line)
"""

import io
import logging
from datetime import datetime
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

logger = logging.getLogger(__name__)

# Brand color (a professional slate blue)
BRAND_COLOR = colors.HexColor("#3B5BDB")
LIGHT_GRAY = colors.HexColor("#F8F9FA")
DARK_GRAY = colors.HexColor("#495057")
BORDER_COLOR = colors.HexColor("#DEE2E6")


def _build_styles() -> dict:
    """Create and return all paragraph styles used in the PDF."""
    base = getSampleStyleSheet()

    styles = {
        "title": ParagraphStyle(
            "Title",
            parent=base["Heading1"],
            fontSize=22,
            textColor=BRAND_COLOR,
            spaceAfter=4 * mm,
            spaceBefore=0,
            fontName="Helvetica-Bold",
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=base["Normal"],
            fontSize=10,
            textColor=DARK_GRAY,
            spaceAfter=2 * mm,
        ),
        "section_header": ParagraphStyle(
            "SectionHeader",
            parent=base["Heading2"],
            fontSize=13,
            textColor=BRAND_COLOR,
            spaceBefore=6 * mm,
            spaceAfter=3 * mm,
            fontName="Helvetica-Bold",
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["Normal"],
            fontSize=10,
            textColor=DARK_GRAY,
            spaceAfter=2 * mm,
            leading=14,  # line height
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["Normal"],
            fontSize=10,
            textColor=DARK_GRAY,
            leftIndent=10,
            spaceAfter=1.5 * mm,
            bulletIndent=0,
            leading=14,
        ),
        "table_header": ParagraphStyle(
            "TableHeader",
            parent=base["Normal"],
            fontSize=9,
            textColor=colors.white,
            fontName="Helvetica-Bold",
        ),
        "table_cell": ParagraphStyle(
            "TableCell",
            parent=base["Normal"],
            fontSize=9,
            textColor=DARK_GRAY,
            leading=12,
        ),
    }
    return styles


def _make_divider() -> HRFlowable:
    """A thin horizontal rule to separate sections."""
    return HRFlowable(width="100%", thickness=0.5, color=BORDER_COLOR, spaceAfter=2 * mm)


def _list_section(title: str, items: list, styles: dict) -> list:
    """
    Build flowables for a bullet-point list section.
    Returns an empty list if items is empty (section is skipped).
    """
    if not items:
        return []

    flowables = [
        Paragraph(title, styles["section_header"]),
        _make_divider(),
    ]
    for item in items:
        text = str(item).strip()
        if text:
            flowables.append(Paragraph(f"• {text}", styles["bullet"]))
    flowables.append(Spacer(1, 3 * mm))
    return flowables


def generate_meeting_pdf(meeting: dict) -> bytes:
    """
    Generate a complete PDF report for a meeting.

    Args:
        meeting: The meeting dict from the database (all fields).

    Returns:
        PDF file as bytes, ready to send as a download response.
    """
    styles = _build_styles()
    buffer = io.BytesIO()

    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=meeting.get("title", "Meeting Report"),
        author="Meeting Summarizer",
    )

    story = []  # list of flowables (building blocks of the PDF)

    # ── Header ──────────────────────────────────────────────
    story.append(Paragraph(meeting.get("title", "Meeting Report"), styles["title"]))

    # Meeting metadata (date, participants)
    meeting_date = meeting.get("meeting_date", "")
    if meeting_date:
        story.append(Paragraph(f"<b>Date:</b> {meeting_date}", styles["subtitle"]))

    participants = meeting.get("participants", "")
    if participants:
        story.append(Paragraph(f"<b>Participants:</b> {participants}", styles["subtitle"]))

    generated_at = datetime.now().strftime("%B %d, %Y at %I:%M %p")
    story.append(Paragraph(f"<i>Report generated: {generated_at}</i>", styles["subtitle"]))
    story.append(Spacer(1, 4 * mm))
    story.append(_make_divider())

    # ── Executive Summary ────────────────────────────────────
    summary = meeting.get("summary", "")
    if summary:
        story.append(Paragraph("Executive Summary", styles["section_header"]))
        story.append(_make_divider())
        story.append(Paragraph(summary, styles["body"]))
        story.append(Spacer(1, 3 * mm))

    # ── Key Discussion Points ────────────────────────────────
    story.extend(_list_section(
        "Key Discussion Points",
        meeting.get("key_points") or [],
        styles,
    ))

    # ── Decisions Made ───────────────────────────────────────
    story.extend(_list_section(
        "Decisions Made",
        meeting.get("decisions") or [],
        styles,
    ))

    # ── Action Items (Table) ─────────────────────────────────
    action_items = meeting.get("action_items") or []
    if action_items:
        story.append(Paragraph("Action Items", styles["section_header"]))
        story.append(_make_divider())

        # Table column headers
        table_data = [[
            Paragraph("Task", styles["table_header"]),
            Paragraph("Assignee", styles["table_header"]),
            Paragraph("Deadline", styles["table_header"]),
            Paragraph("Priority", styles["table_header"]),
            Paragraph("Status", styles["table_header"]),
        ]]

        # Table rows — each action item is a dict
        for item in action_items:
            status_text = item.get("status", "pending").capitalize()
            priority = item.get("priority", "Not specified")

            table_data.append([
                Paragraph(str(item.get("task", "")), styles["table_cell"]),
                Paragraph(str(item.get("assignee", "Not specified")), styles["table_cell"]),
                Paragraph(str(item.get("deadline", "No deadline specified")), styles["table_cell"]),
                Paragraph(priority, styles["table_cell"]),
                Paragraph(status_text, styles["table_cell"]),
            ])

        # Column widths (A4 width minus margins = ~170mm)
        col_widths = [65 * mm, 32 * mm, 32 * mm, 22 * mm, 22 * mm]

        table = Table(table_data, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle([
            # Header row styling
            ("BACKGROUND", (0, 0), (-1, 0), BRAND_COLOR),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            # Data rows
            ("FONTSIZE", (0, 1), (-1, -1), 9),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_GRAY]),
            # Borders
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER_COLOR),
            ("BOX", (0, 0), (-1, -1), 1, BORDER_COLOR),
            # Cell padding
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        story.append(table)
        story.append(Spacer(1, 3 * mm))

    # ── Unresolved Issues ────────────────────────────────────
    story.extend(_list_section(
        "Unresolved Issues",
        meeting.get("unresolved_issues") or [],
        styles,
    ))

    # ── Important Topics ─────────────────────────────────────
    story.extend(_list_section(
        "Important Topics",
        meeting.get("important_topics") or [],
        styles,
    ))

    # ── Transcript (optional, at the end) ────────────────────
    transcript = meeting.get("transcript", "")
    if transcript:
        story.append(Paragraph("Full Transcript", styles["section_header"]))
        story.append(_make_divider())
        # Break transcript into paragraphs at newlines to preserve formatting
        for para in transcript.split("\n"):
            if para.strip():
                story.append(Paragraph(para.strip(), styles["body"]))
        story.append(Spacer(1, 3 * mm))

    # Build the PDF
    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()

    logger.info(f"PDF generated for meeting '{meeting.get('title')}': {len(pdf_bytes)} bytes")
    return pdf_bytes
