/**
 * Registry for protocol translation adaptors.
 *
 * Maps 'source|target' strings to Adaptor instances.
 */
class AdaptorRegistry {
  constructor() {
    this._map = new Map();
  }

  /**
   * Register an adaptor for a source|target pair.
   * @param {import('./base').Adaptor} adaptor
   */
  register(adaptor) {
    const key = `${adaptor.source}|${adaptor.target}`;
    if (this._map.has(key)) {
      throw new Error(`Adaptor already registered for ${key}`);
    }
    this._map.set(key, adaptor);
  }

  /**
   * Get an adaptor for the given source and target.
   * @param {string} source
   * @param {string} target
   * @returns {import('./base').Adaptor|undefined}
   */
  get(source, target) {
    return this._map.get(`${source}|${target}`);
  }

  /**
   * Check if a source|target pair is supported.
   * @param {string} source
   * @param {string} target
   * @returns {boolean}
   */
  has(source, target) {
    return this._map.has(`${source}|${target}`);
  }

  /**
   * Get all registered source|target keys.
   * @returns {string[]}
   */
  keys() {
    return Array.from(this._map.keys());
  }

  /**
   * Get the number of registered adaptors.
   * @returns {number}
   */
  get size() {
    return this._map.size;
  }
}

module.exports = { AdaptorRegistry };
