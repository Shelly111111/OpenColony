/**
 * 虚拟屏幕 - 模拟终端的二维网格
 */

export interface VirtualScreenConfig {
  cols: number;
  rows: number;
}

interface CellState {
  char: string;
}

export class VirtualScreen {
  private cols: number;
  private rows: number;
  private screen: CellState[][];
  private cursorRow: number = 0;
  private cursorCol: number = 0;
  private onScreenUpdate?: (fullScreen: string) => void;
  private onDiffUpdate?: (changedLines: { row: number; content: string }[]) => void;
  private lastScreenContent: string = '';
  private lastScreenLines: string[] = [];

  constructor(config: VirtualScreenConfig) {
    this.cols = config.cols || 120;
    this.rows = config.rows || 40;
    this.screen = [];
    for (let r = 0; r < this.rows; r++) {
      this.screen[r] = [];
      for (let c = 0; c < this.cols; c++) {
        this.screen[r][c] = { char: ' ' };
      }
    }
  }

  setScreenUpdateCallback(callback: (fullScreen: string) => void): void {
    this.onScreenUpdate = callback;
  }

  setDiffUpdateCallback(callback: (changedLines: { row: number; content: string }[]) => void): void {
    this.onDiffUpdate = callback;
  }

  process(data: string): void {
    let i = 0;
    while (i < data.length) {
      if (data[i] === '\x1b') {
        const result = this.parseAnsiSequence(data, i);
        if (result.consumed > 0) {
          this.executeAnsiCommand(result.command, result.params);
          i += result.consumed;
          continue;
        }
      }

      const char = data[i];
      if (char === '\n') {
        this.cursorRow++;
        this.cursorCol = 0;
        if (this.cursorRow >= this.rows) {
          this.scrollScreen();
          this.cursorRow = this.rows - 1;
        }
      } else if (char === '\r') {
        this.cursorCol = 0;
      } else if (char === '\b' || char === '\x7f') {
        if (this.cursorCol > 0) this.cursorCol--;
      } else if (char >= ' ' && char <= '~' || char.charCodeAt(0) > 127) {
        this.putChar(char);
      }
      i++;
    }
    this.checkAndFlushScreen();
  }

  private putChar(char: string): void {
    if (this.cursorRow >= this.rows || this.cursorCol >= this.cols) return;
    this.screen[this.cursorRow][this.cursorCol] = { char };
    this.cursorCol++;
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.cursorRow++;
      if (this.cursorRow >= this.rows) {
        this.scrollScreen();
        this.cursorRow = this.rows - 1;
      }
    }
  }

  private parseAnsiSequence(data: string, start: number): {
    command: string;
    params: string[];
    consumed: number;
  } {
    if (start + 1 >= data.length) {
      return { command: '', params: [], consumed: 0 };
    }

    const seqStart = data[start + 1];

    // CSI 序列 (包括私有模式序列如 \x1b[?2026h)
    if (seqStart === '[') {
      let i = start + 2;
      const params: string[] = [];
      let currentParam = '';
      let privateMode = false;  // 是否为私有模式序列（带 ? 前缀）

      while (i < data.length) {
        const c = data[i];
        if (c >= '0' && c <= '9') {
          currentParam += c;
          i++;
        } else if (c === ';') {
          params.push(currentParam);
          currentParam = '';
          i++;
        } else if (c === '?') {
          // 私有模式前缀（如 DEC 私有模式）
          privateMode = true;
          i++;
        } else if (c >= '@' && c <= '~') {
          // 终止字符 - 序列结束
          if (currentParam) params.push(currentParam);
          // 私有模式命令通常不需要执行，只需要识别并跳过
          return { command: privateMode ? 'PRIVATE' : c, params, consumed: i - start + 1 };
        } else if (c >= ' ' && c <= '/' && c !== '?') {
          // 其他中间字节（除 ? 外）
          i++;
        } else {
          break;
        }
      }
      return { command: '', params: [], consumed: 0 };
    }

    // OSC 序列
    if (seqStart === ']') {
      let i = start + 2;
      while (i < data.length) {
        if (data[i] === '\x07') {
          return { command: 'OSC', params: [], consumed: i - start + 1 };
        }
        if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') {
          return { command: 'OSC', params: [], consumed: i - start + 2 };
        }
        i++;
      }
      return { command: '', params: [], consumed: 0 };
    }

    // 其他单字符序列
    const singleCharCommands: Record<string, string> = {
      '7': 'SAVE_CURSOR',
      '8': 'RESTORE_CURSOR',
      'M': 'SCROLL_UP',
      'D': 'SCROLL_DOWN',
      'E': 'NEXT_LINE',
      '=': 'KEYBOARD_MODE',
      '>': 'KEYBOARD_MODE',
    };
    if (singleCharCommands[seqStart]) {
      return { command: singleCharCommands[seqStart], params: [], consumed: 2 };
    }

    // 字符集选择
    if (seqStart === '(' || seqStart === ')' || seqStart === '*' || seqStart === '+') {
      if (start + 2 < data.length) {
        return { command: 'CHARSET', params: [], consumed: 3 };
      }
    }

    return { command: '', params: [], consumed: 0 };
  }

  private executeAnsiCommand(command: string, params: string[]): void {
    switch (command) {
      case 'A':
        this.cursorRow = Math.max(0, this.cursorRow - parseInt(params[0] || '1'));
        break;
      case 'B':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + parseInt(params[0] || '1'));
        break;
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + parseInt(params[0] || '1'));
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - parseInt(params[0] || '1'));
        break;
      case 'E':
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + parseInt(params[0] || '1'));
        this.cursorCol = 0;
        break;
      case 'F':
        this.cursorRow = Math.max(0, this.cursorRow - parseInt(params[0] || '1'));
        this.cursorCol = 0;
        break;
      case 'G':
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, parseInt(params[0] || '1') - 1));
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.min(this.rows - 1, Math.max(0, parseInt(params[0] || '1') - 1));
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, parseInt(params[1] || '1') - 1));
        break;
      case 'J':
        const modeJ = parseInt(params[0] || '0');
        if (modeJ === 0) this.clearFromCursorToEnd();
        else if (modeJ === 1) this.clearFromStartToCursor();
        else if (modeJ === 2 || modeJ === 3) this.clearScreen();
        break;
      case 'K':
        const modeK = parseInt(params[0] || '0');
        if (modeK === 0) this.clearLineFromCursorToEnd();
        else if (modeK === 1) this.clearLineFromStartToCursor();
        else if (modeK === 2) this.clearEntireLine();
        break;
      case 'SCROLL_UP':
        this.scrollScreen();
        if (this.cursorRow > 0) this.cursorRow--;
        break;
      case 'SCROLL_DOWN':
        this.cursorRow++;
        if (this.cursorRow >= this.rows) {
          this.scrollScreen();
          this.cursorRow = this.rows - 1;
        }
        break;
      case 'NEXT_LINE':
        this.cursorRow++;
        this.cursorCol = 0;
        if (this.cursorRow >= this.rows) {
          this.scrollScreen();
          this.cursorRow = this.rows - 1;
        }
        break;
    }
  }

  private clearFromCursorToEnd(): void {
    this.clearLineFromCursorToEnd();
    for (let r = this.cursorRow + 1; r < this.rows; r++) this.clearEntireRow(r);
  }

  private clearFromStartToCursor(): void {
    for (let r = 0; r < this.cursorRow; r++) this.clearEntireRow(r);
    this.clearLineFromStartToCursor();
  }

  private clearScreen(): void {
    for (let r = 0; r < this.rows; r++) this.clearEntireRow(r);
  }

  private clearLineFromCursorToEnd(): void {
    for (let c = this.cursorCol; c < this.cols; c++) {
      this.screen[this.cursorRow][c] = { char: ' ' };
    }
  }

  private clearLineFromStartToCursor(): void {
    for (let c = 0; c <= this.cursorCol; c++) {
      this.screen[this.cursorRow][c] = { char: ' ' };
    }
  }

  private clearEntireLine(): void {
    this.clearEntireRow(this.cursorRow);
  }

  private clearEntireRow(row: number): void {
    for (let c = 0; c < this.cols; c++) {
      this.screen[row][c] = { char: ' ' };
    }
  }

  private scrollScreen(): void {
    this.screen.shift();
    const newRow: CellState[] = [];
    for (let c = 0; c < this.cols; c++) newRow.push({ char: ' ' });
    this.screen.push(newRow);
  }

  private checkAndFlushScreen(): void {
    const currentContent = this.getScreenContent();
    const currentLines = currentContent.split('\n');
    const changedLines: { row: number; content: string }[] = [];
    for (let i = 0; i < currentLines.length; i++) {
      if (this.lastScreenLines[i] !== currentLines[i]) {
        changedLines.push({ row: i, content: currentLines[i] });
      }
    }
    if (changedLines.length > 0 || currentContent !== this.lastScreenContent) {
      this.lastScreenContent = currentContent;
      this.lastScreenLines = currentLines;
      if (this.onScreenUpdate) this.onScreenUpdate(currentContent);
      if (this.onDiffUpdate && changedLines.length > 0) this.onDiffUpdate(changedLines);
    }
  }

  getScreenContent(): string {
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      for (let c = 0; c < this.cols; c++) line += this.screen[r][c].char;
      lines.push(line.trimEnd());
    }
    return lines.join('\n');
  }
}