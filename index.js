/* global Sat */

const State = {
  PLAYING: "PLAYING",
  WIN: "WIN",
  DEAD: "DEAD",
};

const Hint = {
  MINE: "MINE",
  UNKNOWN: "UNKNOWN",
  SAFE: "SAFE",
};

let storage = localStorage;

class Game {
  constructor(width, height, numMines) {
    this.width = width;
    this.height = height;
    this.numMines = numMines;
    this.map = new LabelMap(this.width, this.height);
    this.flags = makeGrid(this.width, this.height, false);
    this.unsure = makeGrid(this.width, this.height, false);
    this.numRevealed = 0;
    this.undoStack = [];

    this.state = State.PLAYING;

    this.debug = false;
    this.allowOutside = false;
    this.safeMode = false;
    this.countdownMode = false;

    this.lastDuration = 0;
    this.recalc();
  }

  persistToStorage() {
    // If the old state is null, it means the game has either not started, or
    // has been lost (maybe in another window/tab). If nothing has been revealed
    // it's a new game, so perstist. Otherwise, clear the game because they are
    // cheaterz.
    const oldState = storage.getItem("gs");
    if (oldState === null && this.numRevealed > 0) {
      console.log("Resetting game");
      const width = 15;
      const height = 15;
      const numMines = 50;
      game = new Game(width, height, numMines);
      start(game);
      return;
    }
    const encoded = btoa(
      JSON.stringify({
        width: this.width,
        height: this.height,
        numMines: this.numMines,
        map: this.map.toJSON(),
        flags: this.flags,
        unsure: this.unsure,
        numRevealed: this.numRevealed,
        undoStack: this.undoStack,
        state: this.state,
        debug: this.debug,
        allowOutside: this.allowOutside,
        safeMode: this.safeMode,
        countdownMode: this.countdownMode,
        lastDuration: this.lastDuration,
      })
    );
    storage.setItem("gs", encoded);
  }

  static loadFromStorage() {
    const encoded = storage.getItem("gs");
    const decoded = JSON.parse(atob(encoded));
    let game = new Game(decoded.width, decoded.height, decoded.numMines);
    game.map = LabelMap.fromJSON(decoded.map);
    game.flags = decoded.flags;
    game.unsure = decoded.unsure;
    game.numRevealed = decoded.numRevealed;
    game.undoStack = decoded.undoStack;
    game.state = decoded.state;
    game.debug = decoded.debug;
    game.allowOutside = decoded.allowOutside;
    game.safeMode = decoded.safeMode;
    game.countdownMode = decoded.countdownMode;
    game.lastDuration = decoded.lastDuration;
    game.recalc();
    return game;
  }

  score(win) {
    const encoded = storage.getItem("z");

    let decoded;
    try {
      decoded = JSON.parse(atob(encoded));
    } catch (e) {
      decoded = { wins: 0, loss: 0 };
    }

    if (win) {
      decoded.wins = (decoded.wins ?? 0) + 1;
    } else {
      decoded.loss = (decoded.loss ?? 0) + 1;
    }

    const encoded2 = btoa(JSON.stringify(decoded));
    storage.setItem("z", encoded2);
  }

  dumpScore() {
    const encoded = storage.getItem("z");
    const decoded = JSON.parse(atob(encoded));

    console.log("Wins: " + decoded.wins + ", Losses: " + decoded.loss);
    document.getElementById("wins").textContent = "Wins: " + decoded.wins;
    document.getElementById("loss").textContent = "Losses: " + decoded.loss;
  }

  clearStorage() {
    storage.removeItem("gs");
  }

  mount(gameElement) {
    const boardElement = document.createElement("div");
    boardElement.className = "board";
    boardElement.id = "board";
    gameElement.appendChild(boardElement);

    this.cells = [];

    const isTouch =
      "ontouchstart" in window ||
      navigator.MaxTouchPoints > 0 ||
      navigator.msMaxTouchPoints > 0;

    for (let y = 0; y < this.height; y++) {
      this.cells.push([]);
      const row = document.createElement("div");
      row.className = "board-row";
      for (let x = 0; x < this.width; x++) {
        const cell = document.createElement("div");
        cell.className = "cell clickable unknown";
        cell.onclick = (e) => this.cellClick(e, x, y);
        cell.ondblclick = (e) => this.cellDblClick(e, x, y);
        cell.oncontextmenu = (e) => e.preventDefault();
        row.appendChild(cell);
        this.cells[y].push(cell);
      }
      boardElement.appendChild(row);
    }

    this.stateElement = document.createElement("div");
    gameElement.appendChild(this.stateElement);

    this.hintElement = document.getElementById("hint");

    this.refresh();
  }

  cellClick(e, x, y) {
    e.preventDefault();
    if (!this.solver.hasSafeCells()) {
      this.reveal(x, y);
    } else {
      this.toggleFlag(x, y);
    }
  }

  cellDblClick(e, x, y) {
    e.preventDefault();
    if (this.map.labels[y][x] === null && !this.flags[y][x]) {
      this.reveal(x, y);
    } else {
      this.revealAround(x, y);
    }
  }

  revealAround(x, y) {
    if (!(this.state === State.PLAYING && this.map.labels[y][x] !== null)) {
      return;
    }
    let flags = 0;
    for (const [x0, y0] of neighbors(x, y, this.width, this.height)) {
      if (this.flags[y0][x0]) {
        flags++;
      }
    }
    if (this.map.labels[y][x] > flags) {
      return;
    }

    this.undoStack.push([]);
    for (const [x0, y0] of neighbors(x, y, this.width, this.height)) {
      this.reveal(x0, y0, true);
    }
  }

  reveal(x, y, isAround) {
    if (
      !(
        this.state === State.PLAYING &&
        this.map.labels[y][x] === null &&
        !this.flags[y][x]
      )
    ) {
      return;
    }

    if (!isAround) {
      this.undoStack.push([]);
    }

    const hasSafeCells = this.solver.hasSafeCells();
    const hasNonDeadlyCells = this.solver.hasNonDeadlyCells();

    let mineGrid;
    if (this.map.boundaryGrid[y][x] === null) {
      // Clicked somewhere outside of boundary.

      let outsideIsSafe;
      if (this.allowOutside) {
        outsideIsSafe =
          this.map.boundary.length === 0 ||
          this.solver.outsideIsSafe() ||
          (!hasSafeCells && this.solver.outsideCanBeSafe());
      } else {
        outsideIsSafe =
          this.map.boundary.length === 0 ||
          this.solver.outsideIsSafe() ||
          !hasNonDeadlyCells;
      }

      if (outsideIsSafe) {
        const shape = this.solver.anyShapeWithOneEmpty();
        mineGrid = shape.mineGridWithEmpty(x, y);
      } else {
        // const shape = this.solver.anyShapeWithRemaining();
        // mineGrid = shape.mineGridWithMine(x, y);
        return;
      }
    } else {
      // Clicked on boundary.

      const idx = this.map.boundaryGrid[y][x];

      let shape;
      if (
        this.solver.canBeSafe(idx) &&
        (!this.solver.canBeDangerous(idx) || !hasSafeCells)
      ) {
        shape = this.solver.anySafeShape(idx);
      } else {
        shape = this.solver.anyDangerousShape(idx);
      }
      mineGrid = shape.mineGrid();
    }

    if (mineGrid[y][x]) {
      this.state = State.DEAD;
      this.deathX = x;
      this.deathY = y;
      this.mineGrid = mineGrid;
    } else {
      this.floodReveal(x, y, mineGrid);
    }

    this.recalc();
    this.refresh();
  }

  hint() {}

  hasWrongFlags() {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.flags[y][x]) {
          const idx = this.map.boundaryGrid[y][x];

          // Flag on boundary.
          if (idx !== null && this.solver.canBeSafe(idx)) {
            return true;
          }

          // Flag outside. Wrong if there is can be an empty square outside.
          if (idx === null && this.solver.outsideCanBeSafe()) {
            return true;
          }
        }
      }
    }
    return false;
  }

  floodReveal(x, y, mineGrid) {
    let n = 0;
    for (const [x0, y0] of neighbors(x, y, this.width, this.height)) {
      if (mineGrid[y0][x0]) {
        n++;
      }
    }

    this.undoStack[this.undoStack.length - 1].push({
      x: x,
      y: y,
      flag: this.flags[y][x],
      unsure: this.unsure[y][x],
    });

    this.flags[y][x] = false;
    this.unsure[y][x] = false;

    this.map.labels[y][x] = n;
    this.numRevealed++;
    if (this.numRevealed + this.numMines === this.width * this.height) {
      this.state = State.WIN;
      this.mineGrid = mineGrid;
      return;
    }

    if (n === 0) {
      for (const [x0, y0] of neighbors(x, y, this.width, this.height)) {
        if (this.map.labels[y0][x0] === null) {
          this.floodReveal(x0, y0, mineGrid);
        }
      }
    }
  }

  undo() {}

  recalc() {
    const timeStart = new Date();

    this.map.recalc();
    this.solver = makeSolver(this.map, this.numMines);
    this.shapes = this.solver.shapes;

    this.hints = makeGrid(this.width, this.height, null);
    for (let i = 0; i < this.map.boundary.length; i++) {
      const [x, y] = this.map.boundary[i];
      const hasTrue = this.solver.canBeDangerous(i);
      const hasFalse = this.solver.canBeSafe(i);

      let hint = null;
      if (hasTrue && hasFalse) {
        hint = Hint.UNKNOWN;
      } else if (hasTrue && !hasFalse) {
        hint = Hint.MINE;
      } else if (!hasTrue && hasFalse) {
        hint = Hint.SAFE;
      }
      this.hints[y][x] = hint;
    }

    const timeEnd = new Date();
    this.lastDuration = timeEnd - timeStart;
  }

  toggleFlag(x, y) {
    if (!(this.state === State.PLAYING && this.map.labels[y][x] === null)) {
      return;
    }
    if (this.flags[y][x]) {
      this.flags[y][x] = false;
    } else {
      this.flags[y][x] = true;
    }

    this.refresh();
  }

  countFlagsAround(x, y) {
    let result = 0;
    for (const [x0, y0] of neighbors(x, y, this.width, this.height)) {
      if (this.flags[y0][x0]) {
        result++;
      }
    }
    return result;
  }

  countFlags() {
    let result = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.flags[y][x]) {
          result++;
        }
      }
    }
    return result;
  }

  refresh() {
    this.persistToStorage();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const label = this.map.labels[y][x];
        const mine = this.mineGrid && this.mineGrid[y][x];
        const flag = this.flags[y][x];
        const unsure = this.unsure[y][x];
        const hint = this.hints[y][x];

        let unknown;
        if (this.state === State.PLAYING && !this.solver.hasSafeCells()) {
          unknown = "anywhere";
        } else {
          unknown = "unknown";
        }

        let className;
        if (
          this.state === State.DEAD &&
          mine &&
          x === this.deathX &&
          y === this.deathY
        ) {
          className = "known bomb";
        } else if (this.state === State.DEAD && mine) {
          className = `${unknown} bomb`;
        } else if (this.state === State.WIN && mine) {
          className = `${unknown} bomb-win`;
        } else if (label !== null && label > 0) {
          if (this.countdownMode) {
            const modLabel = label - this.countFlagsAround(x, y);
            className = `known label-${modLabel}`;
          } else {
            className = `known label-${label}`;
          }
        } else if (label === 0) {
          className = "known";
        } else if (flag) {
          className = `${unknown} clickable flag`;
        } else if (unsure) {
          className = `${unknown} clickable unsure`;
        } else if (this.state === State.PLAYING) {
          className = `${unknown} clickable`;
        } else {
          className = `${unknown}`;
        }

        if (hint !== null && (this.state === State.DEAD || this.debug)) {
          className += ` hint hint-${hint.toLowerCase()}`;
        }

        this.cells[y][x].className = "cell " + className;
      }
    }

    if (this.state === State.PLAYING && !this.solver.hasSafeCells()) {
      document.body.style.backgroundColor = "green";
    } else {
      document.body.style.backgroundColor = "blue";
    }

    let message;
    switch (this.state) {
      case State.PLAYING:
        {
          const numFlags = this.countFlags();
          message = `Frogs: ${numFlags}/${this.numMines}`;
          if (this.debug) {
            message += ", " + this.solver.debugMessage();
            message += `, time: ${this.lastDuration / 1000} s`;
          }
        }

        break;
      case State.WIN:
        message = "You win!";
        this.clearStorage();
        this.score(true);
        break;
      case State.DEAD:
        message = "You lose!";
        this.clearStorage();
        this.score(false);
        break;
    }
    this.stateElement.textContent = message;

    this.dumpScore();
  }
}

function* neighbors(x, y, width, height) {
  for (let y0 = Math.max(y - 1, 0); y0 < Math.min(y + 2, height); y0++) {
    for (let x0 = Math.max(x - 1, 0); x0 < Math.min(x + 2, width); x0++) {
      if (y0 !== y || x0 !== x) {
        yield [x0, y0];
      }
    }
  }
}

class LabelMap {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.labels = makeGrid(width, height, null);
    this.cache = makeGrid(width, height, null);
    this.recalc();
  }

  toJSON() {
    return {
      width: this.width,
      height: this.height,
      labels: this.labels,
      cache: this.cache,
    };
  }

  static fromJSON(labelMapJSON) {
    let labelMap = new LabelMap(labelMapJSON.width, labelMapJSON.height);
    labelMap.labels = labelMapJSON.labels;
    labelMap.cache = labelMapJSON.cache;
    labelMap.recalc();
    return labelMap;
  }

  recalc() {
    this.boundary = [];
    this.boundaryGrid = makeGrid(this.width, this.height, null);
    let revealedSquares = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // Create the boundary and cache trivially solvable mines
        if (this.labels[y][x] !== null) {
          revealedSquares++;

          // For each labeled revealed square, collect its unknown neighbors and
          // ensure they all have boundary ids.
          const neighboringBoundary = [];
          let hasUncached = false;
          for (const [x0, y0] of neighbors(x, y, this.width, this.height)) {
            if (this.labels[y0][x0] === null) {
              let boundaryId = this.boundaryGrid[y0][x0];
              if (boundaryId === null) {
                boundaryId = this.boundaryGrid[y0][x0] = this.boundary.length;
                this.boundary.push([x0, y0]);
                hasUncached = true;
              }
              if (!hasUncached && this.cache[y0][x0] === null) {
                hasUncached = true;
              }
              neighboringBoundary.push(boundaryId);
            }
          }
          // If this label trivially proves all adjacent boundary squares to be
          // mines, mark them as such.
          if (neighboringBoundary.length === this.labels[y][x] && hasUncached) {
            for (const trivialMineId of neighboringBoundary) {
              this.setCache(trivialMineId, true);
            }
          }
        }
      }
    }
    this.numOutside =
      this.width * this.height - revealedSquares - this.boundary.length;
  }

  setCache(i, val) {
    const [x, y] = this.boundary[i];
    this.cache[y][x] = val;
  }

  getCache(i) {
    const [x, y] = this.boundary[i];
    return this.cache[y][x];
  }

  resetCache() {
    this.cache = makeGrid(this.width, this.height, null);
  }
}

class Shape {
  constructor(map, mines, remaining) {
    this.map = map;
    this.mines = mines;
    this.remaining = remaining;
  }

  baseMineGrid() {
    const mineGrid = makeGrid(this.map.width, this.map.height, false);
    for (let i = 0; i < this.mines.length; i++) {
      if (this.mines[i]) {
        const [x, y] = this.map.boundary[i];
        mineGrid[y][x] = true;
      }
    }
    return mineGrid;
  }

  addRandom(mineGrid, remaining, exceptX, exceptY) {
    if (remaining > 0) {
      const toSelect = [];
      for (let y = 0; y < this.map.height; y++) {
        for (let x = 0; x < this.map.width; x++) {
          if (
            this.map.labels[y][x] === null &&
            this.map.boundaryGrid[y][x] === null &&
            !(x === exceptX && y === exceptY)
          ) {
            toSelect.push([x, y]);
          }
        }
      }
      shuffle(toSelect);
      for (let i = 0; i < remaining; i++) {
        const [x, y] = toSelect[i];
        mineGrid[y][x] = true;
      }
    }

    return mineGrid;
  }

  mineGrid() {
    const mineGrid = this.baseMineGrid();
    this.addRandom(mineGrid, this.remaining);
    return mineGrid;
  }

  mineGridWithMine(x, y) {
    const mineGrid = this.baseMineGrid();
    mineGrid[y][x] = true;
    this.addRandom(mineGrid, this.remaining - 1, x, y);
    return mineGrid;
  }

  mineGridWithEmpty(x, y) {
    const mineGrid = this.baseMineGrid();
    this.addRandom(mineGrid, this.remaining, x, y);
    return mineGrid;
  }
}

class Solver {
  constructor(map, numMines, minMines, maxMines) {
    this.map = map;

    this.numMines = numMines;
    this.minMines = minMines;
    this.maxMines = maxMines;

    this.labels = [];
    this.labelToMine = [];
    this.cache = new Array(numMines).fill(null);

    this.sat = new Sat(this.numMines);

    this._canBeSafe = new Array(numMines).fill(null);
    this._canBeDangerous = new Array(numMines).fill(null);

    this.uncachedMines = [];
    this.numCachedTrue = 0;
    for (let i = 0; i < this.numMines; i++) {
      const c = map.getCache(i);
      this.cache[i] = c;
      if (c === null) {
        this.uncachedMines.push(i);
      } else if (c) {
        this.numCachedTrue++;
      }
    }
  }

  addLabel(label, mineList) {
    const uncachedMineList = [];
    for (const m of mineList) {
      if (this.cache[m] === null) {
        uncachedMineList.push(m);
      } else if (this.cache[m]) {
        label--;
      }
    }

    this.labels.push(label);
    this.labelToMine.push(uncachedMineList);
  }

  run() {
    for (let i = 0; i < this.labels.length; i++) {
      const label = this.labels[i];
      const vars = this.labelToMine[i].map((n) => n + 1);

      this.sat.assertAtLeast(vars, label);
      this.sat.assertAtMost(vars, label);
    }
    for (let i = 0; i < this.numMines; i++) {
      if (this.cache[i] === true) {
        this.sat.assert([i + 1]);
      } else if (this.cache[i] === false) {
        this.sat.assert([-(i + 1)]);
      }
    }

    this.sat.addCounter(this.uncachedMines.map((m) => m + 1));
    this.sat.assertCounterAtLeast(
      Math.max(0, this.minMines - this.numCachedTrue)
    );
    this.sat.assertCounterAtMost(
      Math.max(0, this.maxMines - this.numCachedTrue)
    );

    for (let i = 0; i < this.numMines; i++) {
      if (this.cache[i] !== null) {
        if (this.cache[i]) {
          this._canBeSafe[i] = false;
          this._canBeDangerous[i] = true;
        } else {
          this._canBeSafe[i] = true;
          this._canBeDangerous[i] = false;
        }
        continue;
      }

      if (this._canBeSafe[i] === null) {
        const solution = this.sat.solveWith(() => this.sat.assert([-(i + 1)]));
        if (solution !== null) {
          this.update(solution);
        } else {
          this._canBeSafe[i] = false;
        }
      }

      if (this._canBeDangerous[i] === null) {
        const solution = this.sat.solveWith(() => this.sat.assert([i + 1]));
        if (solution !== null) {
          this.update(solution);
        } else {
          this._canBeDangerous[i] = false;
        }
      }

      if (this._canBeDangerous[i] && !this._canBeSafe[i]) {
        this.map.setCache(i, true);
      } else if (this._canBeSafe[i] && !this._canBeDangerous[i]) {
        this.map.setCache(i, false);
      }
    }
  }

  update(solution) {
    for (let i = 0; i < this.numMines; i++) {
      if (solution[i + 1]) {
        this._canBeDangerous[i] = true;
      } else {
        this._canBeSafe[i] = true;
      }
    }
  }

  shape(solution) {
    if (!solution) {
      return null;
    }
    const mines = solution.slice(1, this.numMines + 1);
    let sum = 0;
    for (const m of mines) {
      if (m) {
        sum++;
      }
    }
    return new Shape(this.map, mines, this.maxMines - sum);
  }

  anyShape() {
    return this.shape(this.sat.solve());
  }

  anyShapeWithOneEmpty() {
    return this.shape(
      this.sat.solveWith(() =>
        this.sat.assertCounterAtLeast(this.minMines - this.numCachedTrue + 1)
      )
    );
  }

  anyShapeWithRemaining() {
    return this.shape(
      this.sat.solveWith(() =>
        this.sat.assertCounterAtMost(this.maxMines - this.numCachedTrue - 1)
      )
    );
  }

  anySafeShape(idx) {
    return this.shape(this.sat.solveWith(() => this.sat.assert([-(idx + 1)])));
  }

  anyDangerousShape(idx) {
    return this.shape(this.sat.solveWith(() => this.sat.assert([idx + 1])));
  }

  canBeSafe(idx) {
    return this._canBeSafe[idx];
  }

  canBeDangerous(idx) {
    return this._canBeDangerous[idx];
  }

  hasSafeCells() {
    for (let i = 0; i < this.numMines; i++) {
      if (!this.canBeDangerous(i)) {
        return true;
      }
    }
    return false;
  }

  hasNonDeadlyCells() {
    for (let i = 0; i < this.numMines; i++) {
      if (this.canBeSafe(i)) {
        return true;
      }
    }
    return false;
  }

  // Check if there is no possibility that outside will contain a mine
  outsideIsSafe() {
    return (
      this.numMines >= this.maxMines &&
      !this.sat.solveWith(() =>
        this.sat.assertCounterAtMost(this.maxMines - this.numCachedTrue - 1)
      )
    );
  }

  // Check if there is a possibility that outside will NOT contain a mine
  outsideCanBeSafe() {
    // we need to have at least minMines+1, if we have minMines that means
    // all the outside squares contain mines.
    return (
      this.minMines < 0 ||
      !!this.sat.solveWith(() =>
        this.sat.assertCounterAtLeast(this.minMines - this.numCachedTrue + 1)
      )
    );
  }

  debugMessage() {
    return (
      `boundary: ${this.numMines}, uncached: ${this.uncachedMines.length}, ` +
      `clauses: ${this.sat.clauses.length}, minMines: ${this.minMines}, maxMines: ${this.maxMines}`
    );
  }
}

function makeSolver(map, maxMines) {
  const minMines = maxMines - map.numOutside;
  const solver = new Solver(map, map.boundary.length, minMines, maxMines);

  for (let x = 0; x < map.width; x++) {
    for (let y = 0; y < map.height; y++) {
      const label = map.labels[y][x];
      if (label === null) {
        continue;
      }

      const mineList = [];
      for (const [x0, y0] of neighbors(x, y, map.width, map.height)) {
        const mineIdx = map.boundaryGrid[y0][x0];
        if (mineIdx !== null) {
          mineList.push(mineIdx);
        }
      }
      if (mineList.length > 0) {
        solver.addLabel(label, mineList);
      }
    }
  }

  solver.run();
  return solver;
}

function makeGrid(width, height, value) {
  const grid = [];
  for (let y = 0; y < height; y++) {
    grid.push(new Array(width).fill(value));
  }
  return grid;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
  return a;
}

let game;

function newGame(event) {
  if (event) {
    event.preventDefault();
  }

  const width = 15;
  const height = 15;
  const numMines = 50;
  game = new Game(width, height, numMines);
  start(game);
}

function start(game) {
  const gameElement = document.getElementById("game");
  gameElement.innerHTML = "";
  game.mount(gameElement);
  updateSettings();
  updateSize();
}

function updateSize() {
  const board = document.getElementById("world");
  if (board.scrollWidth > window.screen.width) {
    const factor = window.screen.width / board.scrollWidth;
    board.style.transform = `scale(${factor})`;
    board.style.transformOrigin = "top left";
    board.style.height = board.scrollHeight * factor + "px";
  } else {
    board.style.transform = "";
    board.style.height = "auto";
  }
}

function hint() {
  game.hint();
}

function undo() {
  game.undo();
}

const SETTINGS = ["debug", "allowOutside", "safeMode", "countdownMode"];

function updateSettings() {
  for (const name of SETTINGS) {
    game[name] = false;
  }
  game.refresh();
}

window.addEventListener("resize", updateSize);

try {
  game = Game.loadFromStorage();
} catch (e) {
  const width = 15;
  const height = 15;
  const numMines = 50;
  game = new Game(width, height, numMines);
}
start(game);
