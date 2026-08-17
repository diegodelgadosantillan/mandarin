# Mandarín Estudio

Aplicación web para estudiar chino mandarín con repetición espaciada. Funciona sin conexión, se
puede instalar como aplicación y **no tiene servidor ni cuentas**: todas las tarjetas y todo el
historial de repasos viven en el navegador (IndexedDB) y nunca salen del dispositivo.

La interfaz está en español.

## Qué hace

**Importación desde Excel/CSV.** Columna 1 hanzi, columna 2 pinyin, columna 3 español. Lee todas
las hojas del libro, admite varios archivos a la vez y salta cualquier fila cuya celda de hanzi no
contenga caracteres chinos. Si la columna 1 no tiene hanzi (por ejemplo cuando el archivo empieza
con una columna de índice), detecta automáticamente la columna correcta y lo indica en la vista
previa. Cada fila se clasifica como **palabra** u **oración**, y la clasificación se puede corregir
fila a fila antes de confirmar.

Reimportar un mazo con el mismo nombre actualiza en su sitio: las filas nuevas se añaden, las
modificadas se actualizan y las que desaparecieron se archivan conservando su historial. La
identidad de cada tarjeta es un hash de (hanzi + español), así que reimportar un archivo corregido
no reinicia el progreso.

**Cuatro modos de ejercicio**, cada uno con su propia programación por tarjeta — reconocer 苹果 y
escribirlo al dictado son habilidades distintas y no comparten fecha de repaso:

| Modo | Tarjetas | Anverso → reverso |
| --- | --- | --- |
| Reconocimiento | palabras | hanzi en 田字格 → pinyin + español + audio |
| Producción | palabras | español → hanzi en 田字格 + pinyin + audio |
| Dictado | todas | audio → escribir hanzi, con diferencia carácter a carácter |
| Ordenar caracteres | oraciones | español → colocar los caracteres en orden (tocar o arrastrar) |

**Programación FSRS-5** con el conjunto de parámetros por defecto (19 pesos). Cuatro notas (Otra
vez / Difícil / Bien / Fácil), intervalo previsto visible en cada botón antes de pulsarlo, pasos de
aprendizaje 1 min → 10 min, límites diarios configurables por modo y detección de tarjetas difíciles
a los 8 fallos, con opción de suspenderlas.

**Estadísticas**: mapa de actividad de 90 días, retención semanal por modo, tarjetas por estado
(nuevas / aprendiendo / jóvenes / maduras), previsión de repasos a 30 días, progreso por nivel HSK y
tiempo medio de respuesta.

**Audio** mediante la Web Speech API con voz zh-CN, velocidad ajustable (0,6×–1×). Si el navegador
no tiene ninguna voz china instalada, el modo dictado se desactiva con un mensaje que lo explica en
lugar de fallar en silencio.

**Copias de seguridad**: exportación e importación completa en JSON, más un migrador para las copias
del prototipo anterior que conserva el historial de repasos.

## Desarrollo

```bash
npm install
npm run dev        # servidor de desarrollo
npm test           # 117 pruebas unitarias
npm run build      # comprueba tipos y compila a dist/
npm run preview    # sirve la compilación (aquí sí funciona el service worker)
```

Requiere Node 20 o superior.

### Estructura

```
src/
  core/        texto CJK, hash estable de identidad
  db/          esquema Dexie (mazos, tarjetas, repasos, registros)
  import/      lectura de Excel/CSV, clasificación, conciliación de mazos
  scheduler/   FSRS-5
  session/     cola de estudio y motor de sesión
  exercises/   un módulo por ejercicio, con interfaz común
  stats/       cálculo de estadísticas (puro)
  ui/          vistas y componentes
test/          pruebas unitarias
scripts/       herramientas de desarrollo (no se compilan)
```

Añadir un quinto ejercicio consiste en crear un módulo en `src/exercises/` que implemente
`ExerciseModule` y registrarlo en `registry.ts`; el motor de sesión no cambia.

### Sobre el planificador

`src/scheduler/fsrs.ts` implementa FSRS-5 directamente, sin dependencias en tiempo de ejecución. Su
corrección se verifica contra la implementación de referencia (`ts-fsrs` 4.7.1, solo dependencia de
desarrollo): 904 vectores de entrada/salida congelados en `test/fsrs-vectors.ts`. Para regenerarlos
tras un cambio deliberado del algoritmo:

```bash
node scripts/gen-fsrs-vectors.ts
```

El script se niega a escribir los vectores si las dos implementaciones no coinciden exactamente.

Otras herramientas: `scripts/check-parse.ts <carpeta>` ejecuta el lector sobre una carpeta de hojas
de cálculo e informa de las columnas detectadas y la clasificación; `scripts/gen-icons.ts` genera
los iconos PNG por geometría, sin dependencias.

## Despliegue

Cada push a `main` compila y publica en GitHub Pages (`.github/workflows/deploy.yml`). La ruta base
se toma del nombre del repositorio mediante `VITE_BASE`, así que renombrarlo no rompe nada.

## Licencia

MIT — ver [LICENSE](LICENSE).
