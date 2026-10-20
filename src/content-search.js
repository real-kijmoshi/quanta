// Shared by board search, notebook search, and server workspace search.
export function searchableObjectText(object) {
  return [object.text, object.props?.pdfText, object.props?.recognizedText, ...(object.props?.audioClips ?? []).map((clip) => clip.transcript)].filter(Boolean).join("\n");
}
