export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the old trick.
    const helper = document.createElement('textarea');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    helper.value = text;
    document.body.append(helper);
    helper.select();
    let done: boolean;
    try {
      done = document.execCommand('copy');
    } catch {
      done = false;
    }
    helper.remove();
    return done;
  }
}
