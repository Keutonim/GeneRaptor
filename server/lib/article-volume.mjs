/**
 * Валидные значения целевого объёма статьи (количество символов).
 * Должны совпадать с volumeOptions панели управления объёмом статьи.
 */
export const volumeOptions = [50000, 55000, 60000, 65000, 70000, 75000, 80000];

export const MIN_VOLUME = 50000;
export const MAX_VOLUME = 80000;
export const VOLUME_STEP = 5000;

/**
 * Проверить, что targetLength входит в список допустимых значений.
 * @param {number} value
 * @returns {boolean}
 */
export function isValidVolume(value) {
  return Number.isInteger(value) && volumeOptions.includes(value);
}

/**
 * Человекочитаемое описание допустимого диапазона объёма.
 * @returns {string}
 */
export function volumeRangeLabel() {
  return `${MIN_VOLUME.toLocaleString('ru-RU')}–${MAX_VOLUME.toLocaleString(
    'ru-RU'
  )} символов с шагом ${VOLUME_STEP.toLocaleString('ru-RU')}`;
}
