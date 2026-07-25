import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const COLOR = {
  ink: "#1a1712",
  inkSoft: "#3a3632",
  muted: "#79736a",
  gold: "#b8894a",
  goldDeep: "#8a6a3f",
  cream: "#faf7f1",
  hairline: "#e6dcc4",
  hairlineFaint: "#f1e9d8",
  white: "#ffffff",
  success: "#2f5233",
  warn: "#8a5a24",
  danger: "#8c3a2e",
  info: "#3a5578",
};

const MARGIN = { left: 50, right: 545 };
const CONTENT_WIDTH = MARGIN.right - MARGIN.left; // 495
const FRAME = { x: 20, y: 20, w: 555, h: 802 };
const ITEMS_LIMIT_Y = 772; // last safe y for a row before forcing a page break
const TOTALS_BLOCK_LIMIT_Y = 812; // last safe y before totals+footer need a fresh page

type FontRole =
  | "display"
  | "displayBlack"
  | "displayItalic"
  | "body"
  | "bodyMedium"
  | "bodySemiBold"
  | "bodyBold";

function setupFonts(doc: PDFKit.PDFDocument): Record<FontRole, string> {
  const dir = path.join(__dirname, "fonts");
  const custom: Record<FontRole, { name: string; file: string }> = {
    display: { name: "Playfair-Bold", file: "PlayfairDisplay-Bold.ttf" },
    displayBlack: { name: "Playfair-Black", file: "PlayfairDisplay-Black.ttf" },
    displayItalic: { name: "Playfair-Italic", file: "PlayfairDisplay-Italic.ttf" },
    body: { name: "Jost-Regular", file: "Jost-Regular.ttf" },
    bodyMedium: { name: "Jost-Medium", file: "Jost-Medium.ttf" },
    bodySemiBold: { name: "Jost-SemiBold", file: "Jost-SemiBold.ttf" },
    bodyBold: { name: "Jost-Bold", file: "Jost-Bold.ttf" },
  };
  // If a custom font file is ever missing or fails to parse, we fall back to a
  // built-in PDF font instead of throwing — the invoice must still generate.
  const fallback: Record<FontRole, string> = {
    display: "Times-Bold",
    displayBlack: "Times-Bold",
    displayItalic: "Times-Italic",
    body: "Helvetica",
    bodyMedium: "Helvetica",
    bodySemiBold: "Helvetica-Bold",
    bodyBold: "Helvetica-Bold",
  };
  const resolved = {} as Record<FontRole, string>;
  (Object.keys(custom) as FontRole[]).forEach((role) => {
    const { name, file } = custom[role];
    try {
      const fp = path.join(dir, file);
      if (!fs.existsSync(fp)) throw new Error("font file missing: " + file);
      doc.registerFont(name, fp);
      resolved[role] = name;
    } catch {
      resolved[role] = fallback[role];
    }
  });
  return resolved;
}

const formatCurrency = (val: number) =>
  `Tk ${Number(val || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function drawPageShell(doc: PDFKit.PDFDocument) {
  doc.lineWidth(1).strokeColor(COLOR.hairline).rect(FRAME.x, FRAME.y, FRAME.w, FRAME.h).stroke();
  doc.rect(20, 20, 555, 9).fill(COLOR.ink);
  doc.rect(20, 29, 555, 2).fill(COLOR.gold);
}

function drawEmblem(doc: PDFKit.PDFDocument, fonts: Record<FontRole, string>, cx: number, cy: number) {
  doc.lineWidth(1.25).strokeColor(COLOR.gold).circle(cx, cy, 19).stroke();
  doc.lineWidth(0.5).strokeColor(COLOR.gold).circle(cx, cy, 15).stroke();
  doc.font(fonts.displayBlack).fontSize(18).fillColor(COLOR.ink);
  const w = doc.widthOfString("L");
  doc.text("L", cx - w / 2, cy - 7);
}

function sectionLabel(doc: PDFKit.PDFDocument, fonts: Record<FontRole, string>, text: string, x: number, y: number) {
  doc.fillColor(COLOR.gold).rect(x, y + 1.5, 3, 3).fill();
  doc
    .font(fonts.bodySemiBold)
    .fontSize(7.3)
    .fillColor(COLOR.gold)
    .text(text, x + 8, y, { characterSpacing: 1 });
}

function outlinedBadge(
  doc: PDFKit.PDFDocument,
  fonts: Record<FontRole, string>,
  text: string,
  x: number,
  y: number,
  w: number,
  color: string
) {
  doc.fillOpacity(0.08).fillColor(color).roundedRect(x, y, w, 15, 7.5).fill();
  doc.fillOpacity(1);
  doc.lineWidth(0.75).strokeColor(color).roundedRect(x, y, w, 15, 7.5).stroke();
  doc
    .font(fonts.bodySemiBold)
    .fontSize(7.2)
    .fillColor(color)
    .text(text.toUpperCase(), x, y + 4.7, { width: w, align: "center", characterSpacing: 0.3 });
}

function drawTableHeader(doc: PDFKit.PDFDocument, fonts: Record<FontRole, string>, y: number): number {
  doc.roundedRect(MARGIN.left, y, CONTENT_WIDTH, 23, 2).fill(COLOR.ink);
  doc.rect(MARGIN.left, y + 23, CONTENT_WIDTH, 1.5).fill(COLOR.gold);
  doc.font(fonts.bodySemiBold).fontSize(8).fillColor(COLOR.white);
  doc.text("ITEM DETAILS", MARGIN.left + 12, y + 8, { characterSpacing: 0.4 });
  doc.text("QTY", 328, y + 8, { width: 42, align: "right", characterSpacing: 0.4 });
  doc.text("UNIT PRICE", 378, y + 8, { width: 82, align: "right", characterSpacing: 0.4 });
  doc.text("TOTAL PRICE", 463, y + 8, { width: 72, align: "right", characterSpacing: 0.4 });
  return y + 23 + 15;
}

function drawContinuationHeader(doc: PDFKit.PDFDocument, fonts: Record<FontRole, string>): number {
  drawPageShell(doc);
  doc.font(fonts.display).fontSize(15).fillColor(COLOR.ink).text("LUXE", 50, 45, { characterSpacing: 2 });
  doc
    .font(fonts.body)
    .fontSize(8)
    .fillColor(COLOR.muted)
    .text("Invoice — continued", 350, 49, { width: 195, align: "right" });
  doc.lineWidth(0.75).strokeColor(COLOR.gold).moveTo(50, 70).lineTo(545, 70).stroke();
  return drawTableHeader(doc, fonts, 82);
}

function drawFooter(doc: PDFKit.PDFDocument, fonts: Record<FontRole, string>, y: number) {
  doc.lineWidth(0.75).strokeColor(COLOR.hairline).moveTo(50, y).lineTo(545, y).stroke();
  doc
    .font(fonts.display)
    .fontSize(10)
    .fillColor(COLOR.gold)
    .text("LUXE", 50, y + 11, { align: "center", width: 495, characterSpacing: 2.5 });
  doc
    .font(fonts.body)
    .fontSize(7.7)
    .fillColor(COLOR.muted)
    .text("Thank you for choosing LUXE. Your premium aesthetic choice is our pride.", 50, y + 26, {
      align: "center",
      width: 495,
    });
  doc.text("For support, write to support@luxe.com or visit luxe.com", 50, y + 39, {
    align: "center",
    width: 495,
  });
}

// ---------------------------------------------------------------------------
// Main export — same signature as before, drop-in replacement
// ---------------------------------------------------------------------------
export const createInvoicePDF = (order: any, invoiceNumber: string): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    try {
      // Margins are set to 0 and every element is positioned by explicit
      // x/y instead. This is deliberate: PDFKit auto-inserts a page break
      // whenever a text() call would land outside its configured margin
      // box, even if the call passes an explicit y. Since this layout
      // places footer/page-number text past the old 50pt margin (inside
      // our own hairline frame), a non-zero margin caused silent, unwanted
      // blank pages. All page breaks in this file are triggered explicitly
      // instead, via ensureSpace()/TOTALS_BLOCK_LIMIT_Y.
      const doc = new PDFDocument({
        size: "A4",
        bufferPages: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      const fonts = setupFonts(doc);

      const buffers: Buffer[] = [];
      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", (err) => reject(err));

      drawPageShell(doc);

      // ---- Header ----------------------------------------------------
      drawEmblem(doc, fonts, 70, 74);

      doc.font(fonts.displayBlack).fontSize(27).fillColor(COLOR.ink).text("LUXE", 100, 48, { characterSpacing: 3 });
      doc
        .font(fonts.bodySemiBold)
        .fontSize(7.3)
        .fillColor(COLOR.gold)
        .text("PREMIUM APPAREL & LUXURY GOODS", 101, 85, { characterSpacing: 1.6 });
      doc
        .font(fonts.body)
        .fontSize(7.5)
        .fillColor(COLOR.muted)
        .text("Gulshan Avenue, Block SE(F), Suite 402, Dhaka  |  support@luxe.com", 101, 98, { width: 340 });

      doc
        .font(fonts.display)
        .fontSize(21)
        .fillColor(COLOR.ink)
        .text("INVOICE", 350, 48, { align: "right", width: 195, characterSpacing: 1 });

      const metaRow = (label: string, value: string, y: number) => {
        doc
          .font(fonts.body)
          .fontSize(7.3)
          .fillColor(COLOR.muted)
          .text(label, 300, y, { width: 130, align: "right", characterSpacing: 0.5 });
        doc.font(fonts.bodyMedium).fontSize(8.3).fillColor(COLOR.inkSoft).text(value, 435, y, { width: 110, align: "right" });
      };
      metaRow("INVOICE NO", invoiceNumber, 83);
      metaRow("ORDER ID", String(order.orderId ?? "—"), 97);
      metaRow("DATE PLACED", String(order.date ?? "—"), 111);

      doc.lineWidth(0.75).strokeColor(COLOR.gold).moveTo(50, 133).lineTo(545, 133).stroke();

      // ---- Billing / Shipping cards -----------------------------------
      const cardY = 146;
      const cardH = 88;
      [50, 310].forEach((x) => {
        doc.fillColor(COLOR.cream).roundedRect(x, cardY, 235, cardH, 4).fill();
        doc.lineWidth(0.75).strokeColor(COLOR.hairline).roundedRect(x, cardY, 235, cardH, 4).stroke();
      });

      sectionLabel(doc, fonts, "BILLED TO", 62, cardY + 12);
      doc.font(fonts.body).fontSize(8.3).fillColor(COLOR.inkSoft);
      doc.text(`${order.customerName ?? "—"}`, 62, cardY + 28, { width: 211, ellipsis: true });
      doc.fillColor(COLOR.muted).text(`${order.customerEmail ?? "—"}`, 62, cardY + 41, { width: 211, ellipsis: true });
      if (order.phone) {
        doc.text(`${order.phone}`, 62, cardY + 54, { width: 211 });
      }

      sectionLabel(doc, fonts, "DELIVERY ADDRESS", 322, cardY + 12);
      doc.font(fonts.body).fontSize(8.3).fillColor(COLOR.inkSoft);
      if (order.addressLine1) {
        doc.text(order.addressLine1, 322, cardY + 28, { width: 211, ellipsis: true });
        let ny = cardY + 41;
        if (order.addressLine2) {
          doc.text(order.addressLine2, 322, ny, { width: 211, ellipsis: true });
          ny += 13;
        }
        const cityStateZip = [order.city, order.state, order.zipCode].filter(Boolean).join(", ");
        doc.fillColor(COLOR.muted).text(cityStateZip || "—", 322, ny, { width: 211, ellipsis: true });
      } else {
        doc.text("Standard home delivery", 322, cardY + 28, { width: 211 });
        doc.fillColor(COLOR.muted).text("Address on dispatch request", 322, cardY + 41, { width: 211 });
      }

      // ---- Payment strip ------------------------------------------------
      const stripY = cardY + cardH + 12;
      doc.fillColor(COLOR.cream).roundedRect(50, stripY, 495, 56, 4).fill();
      doc.lineWidth(0.75).strokeColor(COLOR.hairline).roundedRect(50, stripY, 495, 56, 4).stroke();

      sectionLabel(doc, fonts, "PAYMENT METHOD", 62, stripY + 10);
      sectionLabel(doc, fonts, "PAYMENT STATUS", 185, stripY + 10);
      sectionLabel(doc, fonts, "FULFILLMENT", 295, stripY + 10);
      sectionLabel(doc, fonts, "REFERENCE", 405, stripY + 10);

      const displayMethod =
        order.paymentMethod === "card"
          ? "Stripe (Card)"
          : order.paymentMethod === "bkash"
          ? "bKash Wallet"
          : "Cash on Delivery";
      doc.font(fonts.bodyMedium).fontSize(8.5).fillColor(COLOR.inkSoft).text(displayMethod, 62, stripY + 28, { width: 115 });

      const pStatus = order.paymentStatus || "Pending";
      const isPaid = pStatus.toLowerCase() === "paid";
      const isRefunded = pStatus.toLowerCase() === "refunded";
      const pColor = isPaid ? COLOR.success : isRefunded ? COLOR.danger : COLOR.warn;
      outlinedBadge(doc, fonts, pStatus, 185, stripY + 25, 90, pColor);

      const fStatus = order.fulfillmentStatus || "Processing";
      const isDelivered = ["delivered", "completed"].includes(fStatus.toLowerCase());
      const isCancelled = ["canceled", "cancelled"].includes(fStatus.toLowerCase());
      const fColor = isDelivered ? COLOR.success : isCancelled ? COLOR.danger : COLOR.info;
      outlinedBadge(doc, fonts, fStatus, 295, stripY + 25, 90, fColor);

      let txnVal = order.transactionId || "";
      if (order.couponCode) txnVal += (txnVal ? "  ·  " : "") + `Code: ${order.couponCode}`;
      if (!txnVal) txnVal = isPaid ? "Stripe autopay ref." : "COD handover ref.";
      doc.font(fonts.body).fontSize(7.8).fillColor(COLOR.inkSoft).text(txnVal, 405, stripY + 28, { width: 130, ellipsis: true });

      // ---- Line items table ----------------------------------------
      let y = drawTableHeader(doc, fonts, stripY + 56 + 12);
      let rowIndex = 0;

      const ensureSpace = (needed: number) => {
        if (y + needed > ITEMS_LIMIT_Y) {
          doc
            .font(fonts.body)
            .fontSize(7.5)
            .fillColor(COLOR.muted)
            .text("continued on next page →", 50, 793, { width: 495, align: "right" });
          doc.addPage();
          y = drawContinuationHeader(doc, fonts);
          rowIndex = 0;
        }
      };

      const drawRow = (name: string, specs: string | undefined, qty: number, price: number) => {
        const rowH = specs ? 34 : 24;
        ensureSpace(rowH + 6);
        if (rowIndex % 2 === 0) {
          doc.fillColor(COLOR.hairlineFaint).rect(50, y - 7, 495, rowH).fill();
        }
        doc.font(fonts.bodySemiBold).fontSize(9).fillColor(COLOR.inkSoft).text(name, 62, y, { width: 255 });
        if (specs) {
          doc.font(fonts.body).fontSize(7.6).fillColor(COLOR.muted).text(specs, 62, y + 12, { width: 255 });
        }
        doc.font(fonts.body).fontSize(8.7).fillColor(COLOR.inkSoft);
        doc.text(String(qty), 328, y, { width: 42, align: "right" });
        doc.text(formatCurrency(price), 378, y, { width: 82, align: "right" });
        doc.font(fonts.bodyBold).fontSize(9).fillColor(COLOR.ink).text(formatCurrency(price * qty), 463, y, { width: 72, align: "right" });
        y += rowH;
        doc.lineWidth(0.5).strokeColor(COLOR.hairlineFaint).moveTo(50, y).lineTo(545, y).stroke();
        y += 9;
        rowIndex++;
      };

      const items = (order.items as any[]) || [];
      if (items.length === 0) {
        drawRow("Order Package / Aura Premium Purchase", undefined, 1, Number(order.total || 0));
      } else {
        items.forEach((item: any) => {
          drawRow(
            item.name || "Product Item",
            item.specsText,
            Number(item.quantity || item.qty || 1),
            Number(item.price || 0)
          );
        });
      }

      // ---- Totals ----------------------------------------------------
      const calculatedSubtotal =
        items.length > 0
          ? items.reduce((acc, item) => acc + Number(item.price || 0) * Number(item.quantity || item.qty || 1), 0)
          : Number(order.total || 0);
      const taxAmount = items.length > 0 ? calculatedSubtotal * 0.08 : 0;
      const rawTotalBeforeDiscount = calculatedSubtotal + taxAmount;
      let deliveryFee = 0;
      let discountAmount = 0;
      if (order.total > rawTotalBeforeDiscount) deliveryFee = order.total - rawTotalBeforeDiscount;
      else if (order.total < rawTotalBeforeDiscount) discountAmount = rawTotalBeforeDiscount - order.total;

      let extraRows = 1;
      if (deliveryFee > 0) extraRows++;
      if (discountAmount > 0) extraRows++;
      const totalsHeight = 16 * extraRows + 22 + 36;
      const footerHeight = 62;

      if (y + totalsHeight + footerHeight > TOTALS_BLOCK_LIMIT_Y) {
        doc.addPage();
        drawPageShell(doc);
        y = 60;
      }

      y += 6;
      doc.font(fonts.body).fontSize(9).fillColor(COLOR.inkSoft);
      doc.text("Subtotal", 335, y);
      doc.text(formatCurrency(calculatedSubtotal), 465, y, { width: 70, align: "right" });
      y += 16;
      doc.text("Tax (8%)", 335, y);
      doc.text(formatCurrency(taxAmount), 465, y, { width: 70, align: "right" });

      if (deliveryFee > 0) {
        y += 16;
        doc.text("Delivery Fee", 335, y);
        doc.text(formatCurrency(deliveryFee), 465, y, { width: 70, align: "right" });
      }
      if (discountAmount > 0) {
        y += 16;
        const label = order.couponCode ? `Discount (${order.couponCode})` : "Discount";
        doc.fillColor(COLOR.danger).text(label, 300, y, { width: 150 });
        doc.text(`-${formatCurrency(discountAmount)}`, 465, y, { width: 70, align: "right" });
        doc.fillColor(COLOR.inkSoft);
      }

      y += 22;
      doc.fillColor(COLOR.cream).roundedRect(325, y - 8, 220, 36, 4).fill();
      doc.lineWidth(1).strokeColor(COLOR.gold).roundedRect(325, y - 8, 220, 36, 4).stroke();
      doc
        .font(fonts.bodySemiBold)
        .fontSize(9)
        .fillColor(COLOR.goldDeep)
        .text("GRAND TOTAL", 340, y - 2, { characterSpacing: 0.8 });
      doc
        .font(fonts.displayBlack)
        .fontSize(15)
        .fillColor(COLOR.ink)
        .text(formatCurrency(Number(order.total || 0)), 335, y + 9, { width: 195, align: "right" });

      // ---- Footer ------------------------------------------------------
      const footerY = Math.max(y + 34, 748);
      drawFooter(doc, fonts, footerY);

      // ---- Page numbers (continuation pages only) -----------------------
      const range = doc.bufferedPageRange();
      if (range.count > 1) {
        for (let i = range.start; i < range.start + range.count - 1; i++) {
          doc.switchToPage(i);
          doc
            .font(fonts.body)
            .fontSize(7)
            .fillColor(COLOR.muted)
            .text(`Page ${i + 1} of ${range.count}`, 50, 803, { width: 495, align: "center" });
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};