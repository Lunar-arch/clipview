function parseHttpLine(line) {
  const direct = line.match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+([^\s]+)\s+(\d{3})\b/i);
  if (direct) {
    return {
      method: direct[1].toUpperCase(),
      target: direct[2],
      status: Number(direct[3]),
    };
  }

  const reverse = line.match(/\b(\d{3})\b.*\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+([^\s]+)/i);
  if (reverse) {
    return {
      method: reverse[2].toUpperCase(),
      target: reverse[3],
      status: Number(reverse[1]),
    };
  }

  return null;
}

function shouldSuppressLine(line, frameworkId) {
  const lower = line.toLowerCase();

  if (!lower.trim()) {
    return true;
  }

  if (frameworkId === "next") {
    if (lower.includes("compiled") || lower.includes("ready in") || lower.includes("event - compiled")) {
      return true;
    }

    if (lower.includes("_next/static")) {
      return true;
    }
  }

  return false;
}

function formatStructuredLine(line, frameworkId, isError) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (shouldSuppressLine(trimmed, frameworkId)) {
    return null;
  }

  const http = parseHttpLine(trimmed);
  if (http) {
    if (http.status >= 400) {
      return `${http.method} ${http.target} ${http.status}`;
    }
    return `${http.method} ${http.target} ${http.status} | Saved`;
  }

  if (isError || /\b(error|failed|exception)\b/i.test(trimmed)) {
    const message = trimmed.replace(/^error[:\s-]*/i, "").trim();
    return `Error ${message || "Unknown failure"}`;
  }

  if (/started server on|listening on|local:\s+http/i.test(trimmed)) {
    return trimmed;
  }

  return trimmed;
}

export function createDevOutputFormatter(mode = "raw", frameworkId = "generic") {
  const normalizedMode = mode === "structured" ? "structured" : "raw";
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const processLines = (input, isError, bufferKind) => {
    if (normalizedMode === "raw") {
      return input;
    }

    if (bufferKind === "stdout") {
      stdoutBuffer += input;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      const formatted = lines.map((line) => formatStructuredLine(line, frameworkId, isError)).filter(Boolean);
      return formatted.length > 0 ? `${formatted.join("\n")}\n` : "";
    }

    stderrBuffer += input;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    const formatted = lines.map((line) => formatStructuredLine(line, frameworkId, isError)).filter(Boolean);
    return formatted.length > 0 ? `${formatted.join("\n")}\n` : "";
  };

  return {
    formatStdout(chunk) {
      return processLines(chunk.toString(), false, "stdout");
    },
    formatStderr(chunk) {
      return processLines(chunk.toString(), true, "stderr");
    },
    flush() {
      if (normalizedMode === "raw") {
        return "";
      }

      const trailing = [];
      if (stdoutBuffer.trim()) {
        const line = formatStructuredLine(stdoutBuffer, frameworkId, false);
        if (line) {
          trailing.push(line);
        }
      }

      if (stderrBuffer.trim()) {
        const line = formatStructuredLine(stderrBuffer, frameworkId, true);
        if (line) {
          trailing.push(line);
        }
      }

      stdoutBuffer = "";
      stderrBuffer = "";

      return trailing.length > 0 ? `${trailing.join("\n")}\n` : "";
    },
  };
}
