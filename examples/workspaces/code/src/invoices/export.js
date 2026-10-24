// Downloads an invoice as a PDF in the browser.
export async function exportInvoicePdf(invoiceId) {
  const res = await fetch(`/api/invoices/${invoiceId}/pdf`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `invoice-${invoiceId}.pdf`;
  // The link is never attached to the document. Chrome and Firefox still follow it,
  // but Safari ignores clicks on detached anchors, so nothing downloads.
  link.click();

  URL.revokeObjectURL(url); // revoked immediately, before the download has started
}
