"use strict";

const upper = (value) => String(value ?? "").toUpperCase();

class SchemaResolver {
  constructor(keywords) {
    this.keywords = keywords;
    this.cache = new Map();
  }

  moduleNames() {
    return this.keywords?.getModuleNames?.() ?? [];
  }

  lookup(moduleName, commandName) {
    if (!moduleName || !commandName || !this.keywords) return null;
    const key = `${upper(moduleName)}:${upper(commandName)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let owner = upper(moduleName);
    let schema = this.keywords.getCommandSchema(owner, commandName);
    if (!schema) {
      owner = "BASIC";
      schema = this.keywords.getCommandSchema(owner, commandName);
    }
    if (!schema) {
      this.cache.set(key, null);
      return null;
    }
    const forms = schema.forms ?? [];
    const params = new Map();
    for (const form of forms) {
      for (const slot of form.slots ?? []) {
        if (!slot.name) continue;
        const name = upper(slot.name);
        if (!params.has(name)) params.set(name, []);
        params.get(name).push(slot);
      }
    }
    const result = { owner, schema, forms, params, command: upper(commandName) };
    this.cache.set(key, result);
    return result;
  }

  commands(moduleName) {
    if (!moduleName || !this.keywords) return [];
    return [
      ...new Set([
        ...(this.keywords.getModuleCommands(moduleName) ?? []),
        ...(this.keywords.getModuleCommands("BASIC") ?? []),
      ]),
    ];
  }

  enums(info, paramName) {
    return [
      ...new Set(
        (info?.params.get(upper(paramName)) ?? []).flatMap((slot) => slot.enumValues ?? []),
      ),
    ];
  }

  slotFor(info, paramName, position) {
    if (!info) return null;
    const candidates = info.forms
      .map((form) => {
        const slots = form.slots ?? [];
        const index = paramName
          ? slots.findIndex((slot) => upper(slot.name) === upper(paramName))
          : position;
        return index < 0 ? null : { slot: slots[index], index };
      })
      .filter((item) => item?.slot);
    if (!candidates.length) return null;
    const names = new Set(candidates.map(({ slot }) => upper(slot.name)));
    const indexes = new Set(candidates.map(({ index }) => index));
    return {
      param: names.size === 1 ? candidates[0].slot.name : null,
      activeParameter: indexes.size === 1 ? candidates[0].index : null,
      candidates,
    };
  }

  resolve(tokens, state, commandOffset = 0) {
    const info = this.lookup(state.module, state.command);
    if (!info) return { info: null, assignments: [], tableHeader: null, confidence: false };
    const values = tokens
      .slice(commandOffset)
      .filter((token) => !["comment", "continuation"].includes(token.type));
    const isHeader =
      commandOffset > 0 &&
      values.length > 0 &&
      values.every((token) => token.type === "word" && info.params.has(upper(token.value)));
    if (isHeader) {
      return {
        info,
        tableHeader: values.map((token) => upper(token.value)),
        assignments: values.map((token) => ({
          token,
          role: "param",
          param: upper(token.value),
          ...this.slotFor(info, token.value, 0),
        })),
        confidence: true,
      };
    }
    let param = state.continuationParam ?? null;
    let awaitingValue = state.continuationAwaitingValue ?? Boolean(param);
    let positional = state.continuationPosition ?? 0;
    const usedParams = new Set(state.continuationUsedParams ?? []);
    if (param) usedParams.add(upper(param));
    let previous = null;
    let confidence = true;
    const assignments = [];
    for (let index = 0; index < values.length; index++) {
      const token = values[index];
      const name = upper(token.value);
      const adjacent = previous && previous.end === token.start;
      const nested = token.depth > 0 || token.type === "punctuation" || adjacent;
      const current = this.slotFor(info, param, positional);
      const enumCollision =
        token.type === "word" &&
        param &&
        this.enums(info, param).some((value) => upper(value) === name);
      if (token.type === "word" && !nested && info.params.has(name)) {
        const next = values[index + 1];
        if (enumCollision && awaitingValue && !next) {
          assignments.push({ token, role: "value", ...current, param });
          awaitingValue = false;
        } else if (enumCollision && awaitingValue && next?.type !== "equals") {
          confidence = false;
          assignments.push({
            token,
            role: "value",
            param: null,
            activeParameter: null,
            ambiguous: true,
          });
          param = null;
          awaitingValue = false;
        } else {
          param = name;
          awaitingValue = true;
          usedParams.add(name);
          assignments.push({
            token,
            role: "param",
            ...this.slotFor(info, param, positional),
            param,
          });
        }
        previous = token;
        continue;
      }
      const consumedValue =
        !awaitingValue && param && (previous?.role !== "param" || state.continuationParam);
      const partialNames =
        token.type === "word" &&
        /^[A-Za-z][A-Za-z0-9_.-]*$/.test(token.value) &&
        !nested &&
        consumedValue &&
        !state.tableHeader &&
        index === values.length - 1
          ? [...info.params.keys()].filter(
              (candidate) => !usedParams.has(candidate) && candidate.startsWith(name),
            )
          : [];
      if (partialNames.length) {
        const partialSlot =
          partialNames.length === 1 ? this.slotFor(info, partialNames[0], positional) : null;
        assignments.push({
          token,
          role: "param",
          partialParam: true,
          paramCandidates: partialNames,
          param: partialSlot?.param ?? null,
          activeParameter: partialSlot?.activeParameter ?? null,
        });
        previous = token;
        continue;
      }
      const tableParam = state.tableHeader?.[positional];
      const slot = tableParam ? this.slotFor(info, tableParam, positional) : current;
      assignments.push({
        token,
        role: "value",
        param: param ?? slot?.param ?? null,
        activeParameter: slot?.activeParameter ?? null,
        candidates: slot?.candidates ?? [],
      });
      if (!nested && !param) positional++;
      if (!["punctuation", "equals"].includes(token.type)) awaitingValue = false;
      previous = token;
    }
    return {
      info,
      assignments,
      tableHeader: null,
      confidence,
      param,
      positional,
      awaitingValue,
      usedParams: [...usedParams],
    };
  }
}

module.exports = { SchemaResolver, upper };
