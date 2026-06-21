import html
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


WORD_PARTS = [
    "word/document.xml",
    "word/header1.xml",
    "word/header2.xml",
    "word/header3.xml",
    "word/footer1.xml",
    "word/footer2.xml",
    "word/footer3.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
]


NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
}


def normalize_text(value):
    value = html.unescape(value or "")
    value = re.sub(r"\r\n?", "\n", value)
    value = re.sub(r"[ \t\u00a0]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def text_from_paragraph(paragraph):
    chunks = []
    for node in paragraph.iter():
        tag = node.tag.rsplit("}", 1)[-1]
        if tag == "t" and node.text:
            chunks.append(node.text)
        elif tag == "tab":
            chunks.append("\t")
        elif tag == "br":
            chunks.append("\n")
    return normalize_text("".join(chunks))


def extract_xml_text(xml_bytes):
    root = ET.fromstring(xml_bytes)
    paragraphs = []

    for paragraph in root.findall(".//w:p", NS):
        text = text_from_paragraph(paragraph)
        if text:
            paragraphs.append(text)

    if paragraphs:
        return "\n".join(paragraphs)

    fallback = "".join(root.itertext())
    return normalize_text(fallback)


def extract_docx(path):
    texts = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        for part in WORD_PARTS:
            if part not in names:
                continue
            text = extract_xml_text(archive.read(part))
            if text:
                texts.append(text)

    text = normalize_text("\n\n".join(texts))
    if not text:
        raise ValueError("docx 文件中没有解析到可用正文。")

    return {
        "ok": True,
        "text": text,
        "charCount": len(text),
    }


def main():
    if len(sys.argv) < 2:
        raise ValueError("缺少 docx 文件路径。")

    payload = extract_docx(sys.argv[1])
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
