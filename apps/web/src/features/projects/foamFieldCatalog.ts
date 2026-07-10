/**
 * foamFieldCatalog.ts - the "easy mode" field catalog for OpenFOAM case files.
 *
 * For each recognised file (matched by its FoamFile `object`, optionally narrowed
 * by `className`), this lists the editable fields and — for enumerated ones —
 * the exact allowed OpenFOAM tokens, so the form editor can offer a dropdown.
 * Sourced from docs/DOCUMENTATION.md (OpenFOAM v2412), supplemented with common
 * OpenFOAM knowledge where the doc is non-exhaustive.
 *
 * GENERATED/curated data — keep option strings as exact OpenFOAM tokens.
 */

/** How a field is edited in the form. */
export type FoamFieldKind =
  | 'enum' // pick one of `options`
  | 'scalar' // a real number (free numeric input)
  | 'integer' // an integer
  | 'bool' // on/off-style flag (options give the exact token pair to write)
  | 'vector' // a 3-vector like (0 0 0)
  | 'dimensions' // a [0 1 -1 0 0 0 0] dimension set
  | 'dimensioned' // dimensions + value, e.g. `[0 2 -1 0 0 0 0] 1e-06`
  | 'text'; // freeform fallback

/** One editable keyword within a file or sub-dictionary. */
export interface FoamFieldDef {
  /** The OpenFOAM keyword exactly as written in the file. */
  key: string;
  /** Short, human label (English) shown next to the control. */
  label: string;
  kind: FoamFieldKind;
  /** Allowed tokens for `enum`/`bool` (for bool, list the canonical pair, on-token first). */
  options?: string[];
  /** One concise English sentence of help. */
  help?: string;
  /** A representative example value. */
  example?: string;
}

/** A named sub-dictionary inside a file (e.g. `RAS`, `SIMPLE`, `solvers`). */
export interface FoamSubDictDef {
  key: string;
  label: string;
  help?: string;
  fields: FoamFieldDef[];
}

/** A recognised OpenFOAM file and its editable structure. */
export interface FoamFileDef {
  /** FoamFile `object` to match (e.g. 'controlDict', 'U'). */
  object: string;
  /** Optional FoamFile `class` to narrow the match (e.g. 'volVectorField'). */
  className?: string;
  /** English display title for the form header. */
  title: string;
  /** Optional one-line English description. */
  description?: string;
  /** Top-level editable keywords. */
  fields: FoamFieldDef[];
  /** Named sub-dictionaries (e.g. turbulenceProperties.RAS, fvSolution.SIMPLE). */
  subDicts?: FoamSubDictDef[];
  /**
   * For 0/ field files (U, p, k, …): the allowed boundary-condition `type`
   * tokens for each boundaryField patch (deduplicated, flattened from the doc's
   * categorised lists). The form shows one `type` <select> per patch.
   */
  boundaryFieldTypes?: string[];
}

export const FOAM_FIELD_CATALOG: FoamFileDef[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // 0/ FIELD FILES
  // ─────────────────────────────────────────────────────────────────────────
  {
    object: 'U',
    className: 'volVectorField',
    title: 'Velocity field (U)',
    description:
      'Vector velocity field (m/s), the primary unknown solved by the momentum equation.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'SI dimension exponents [kg m s K mol A cd]; velocity is m/s.',
        example: '[0 1 -1 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform (0 0 0)` for fluid at rest.',
        example: 'uniform (0 0 0)',
      },
    ],
    // Flattened + de-duplicated from the doc's exhaustive list for U.
    boundaryFieldTypes: [
      'fixedValue',
      'uniformFixedValue',
      'noSlip',
      'movingWallVelocity',
      'rotatingWallVelocity',
      'surfaceNormalFixedValue',
      'fixedNormalSlip',
      'zeroGradient',
      'fixedGradient',
      'inletOutlet',
      'outletInlet',
      'slip',
      'partialSlip',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'flowRateInletVelocity',
      'flowRateOutletVelocity',
      'variableHeightFlowRate',
      'pressureInletVelocity',
      'pressureInletOutletVelocity',
      'pressureDirectedInletVelocity',
      'pressureDirectedInletOutletVelocity',
      'pressureNormalInletOutletVelocity',
      'freestream',
      'freestreamVelocity',
      'outletPhaseMeanVelocity',
      'turbulentInlet',
      'turbulentDFSEMInlet',
      'mappedFixedValue',
      'timeVaryingMappedFixedValue',
      'interpolatedHarmonicFixedValue',
      'atmBoundaryLayerInletVelocity',
      'calculated',
      'codedFixedValue',
      'fixedMean',
      'waveVelocity',
    ],
  },
  {
    object: 'p',
    className: 'volScalarField',
    title: 'Pressure field (p)',
    description:
      'Kinematic pressure (p/rho, m²/s²) for incompressible solvers; a relative (gauge) pressure.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'Kinematic pressure is m²/s² (mass divided out by rho in incompressible solvers).',
        example: '[0 2 -2 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform 0` for zero reference pressure.',
        example: 'uniform 0',
      },
    ],
    // Flattened + de-duplicated from the doc's exhaustive list for p.
    boundaryFieldTypes: [
      'fixedValue',
      'uniformFixedValue',
      'totalPressure',
      'prghTotalHydrostaticPressure',
      'prghPressure',
      'prghTotalPressure',
      'zeroGradient',
      'fixedGradient',
      'fixedFluxPressure',
      'fixedFluxExtrapolatedPressure',
      'inletOutlet',
      'outletInlet',
      'freestreamPressure',
      'waveSurfacePressure',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'slip',
      'uniformDensityHydrostaticPressure',
      'calculated',
      'codedFixedValue',
      'codedMixed',
    ],
  },
  {
    object: 'k',
    className: 'volScalarField',
    title: 'Turbulent kinetic energy (k)',
    description:
      'Turbulent kinetic energy per unit mass (m²/s²), a transported variable of k-omega / k-epsilon models.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'Turbulent kinetic energy per unit mass is m²/s².',
        example: '[0 2 -2 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform 0.003054` from a turbulence estimate.',
        example: 'uniform 0.003054',
      },
    ],
    // Flattened + de-duplicated from the doc's exhaustive list for k.
    boundaryFieldTypes: [
      'kqRWallFunction',
      'kLowReWallFunction',
      'turbulentIntensityKineticEnergyInlet',
      'fixedValue',
      'uniformFixedValue',
      'atmBoundaryLayerInletK',
      'mappedFixedValue',
      'turbulentInlet',
      'inletOutlet',
      'zeroGradient',
      'outletInlet',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'slip',
      'calculated',
      'fixedGradient',
      'codedFixedValue',
    ],
  },
  {
    object: 'omega',
    className: 'volScalarField',
    title: 'Specific dissipation rate (omega)',
    description:
      'Specific dissipation rate (1/s), the second transported variable of k-omega / k-omega SST models.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'Specific dissipation rate is 1/s.',
        example: '[0 0 -1 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform 0.4806` from a mixing-length estimate.',
        example: 'uniform 0.4806',
      },
    ],
    // Flattened + de-duplicated from the doc's exhaustive list for omega.
    boundaryFieldTypes: [
      'omegaWallFunction',
      'turbulentMixingLengthFrequencyInlet',
      'fixedValue',
      'uniformFixedValue',
      'atmBoundaryLayerInletOmega',
      'mappedFixedValue',
      'inletOutlet',
      'zeroGradient',
      'outletInlet',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'slip',
      'calculated',
      'fixedGradient',
      'codedFixedValue',
    ],
  },
  {
    object: 'nut',
    className: 'volScalarField',
    title: 'Turbulent viscosity (nut)',
    description:
      'Kinematic turbulent (eddy) viscosity (m²/s), a derived field computed from k and omega, not transported.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'Kinematic turbulent viscosity is m²/s.',
        example: '[0 2 -1 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform 0` (recomputed by the solver).',
        example: 'uniform 0',
      },
    ],
    // Flattened + de-duplicated from the doc's exhaustive list for nut.
    boundaryFieldTypes: [
      'nutkWallFunction',
      'nutkRoughWallFunction',
      'nutkAtmRoughWallFunction',
      'nutUWallFunction',
      'nutUSpaldingWallFunction',
      'nutUBlendedWallFunction',
      'nutLowReWallFunction',
      'nutURoughWallFunction',
      'nutUTabulatedWallFunction',
      'nutSpaldingWallFunction',
      'calculated',
      'zeroGradient',
      'inletOutlet',
      'freestream',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'slip',
      'fixedValue',
      'uniformFixedValue',
    ],
  },
  {
    object: 'epsilon',
    className: 'volScalarField',
    title: 'Turbulent dissipation rate (epsilon)',
    description:
      'Turbulent kinetic energy dissipation rate (m²/s³), the second transported variable of k-epsilon models.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'Turbulent dissipation rate is m²/s³ (commonly used).',
        example: '[0 2 -3 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform 0.1` from a turbulence estimate.',
        example: 'uniform 0.1',
      },
    ],
    // Not in the doc; analogous to omega/k turbulence-field types (commonly used).
    boundaryFieldTypes: [
      'epsilonWallFunction',
      'turbulentMixingLengthDissipationRateInlet',
      'fixedValue',
      'uniformFixedValue',
      'atmBoundaryLayerInletEpsilon',
      'mappedFixedValue',
      'inletOutlet',
      'zeroGradient',
      'outletInlet',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'slip',
      'calculated',
      'fixedGradient',
      'codedFixedValue',
    ],
  },
  {
    object: 'nuTilda',
    className: 'volScalarField',
    title: 'Spalart-Allmaras variable (nuTilda)',
    description:
      'Modified kinematic turbulent viscosity (m²/s), the single transported variable of the Spalart-Allmaras model.',
    fields: [
      {
        key: 'dimensions',
        label: 'Dimensions',
        kind: 'dimensions',
        help: 'Modified kinematic turbulent viscosity is m²/s (commonly used).',
        example: '[0 2 -1 0 0 0 0]',
      },
      {
        key: 'internalField',
        label: 'Internal field',
        kind: 'text',
        help: 'Initial value in the volume, e.g. `uniform 0` or a small freestream value.',
        example: 'uniform 0',
      },
    ],
    // Not in the doc; analogous Spalart-Allmaras / generic turbulence-field types (commonly used).
    boundaryFieldTypes: [
      'fixedValue',
      'uniformFixedValue',
      'inletOutlet',
      'outletInlet',
      'zeroGradient',
      'freestream',
      'mappedFixedValue',
      'symmetry',
      'symmetryPlane',
      'cyclic',
      'cyclicAMI',
      'empty',
      'wedge',
      'slip',
      'calculated',
      'fixedGradient',
      'codedFixedValue',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // constant/
  // ─────────────────────────────────────────────────────────────────────────
  {
    object: 'transportProperties',
    title: 'Transport properties',
    description:
      'Selects the rheological (transport) model and the fluid viscosity for incompressible solvers.',
    fields: [
      {
        key: 'transportModel',
        label: 'Transport model',
        kind: 'enum',
        options: [
          'Newtonian',
          'CrossPowerLaw',
          'BirdCarreau',
          'powerLaw',
          'HerschelBulkley',
          'Casson',
          'strainRateFunction',
        ],
        help: 'Rheology model; non-Newtonian models read coefficients from a `<model>Coeffs` sub-dictionary.',
        example: 'Newtonian',
      },
      {
        key: 'nu',
        label: 'Kinematic viscosity (nu)',
        kind: 'dimensioned',
        help: 'Kinematic viscosity required by Newtonian (e.g. water ≈ 1e-06 m²/s).',
        example: '[0 2 -1 0 0 0 0] 1e-06',
      },
    ],
  },
  {
    object: 'turbulenceProperties',
    title: 'Turbulence properties',
    description:
      'Selects the turbulence-modelling approach and the precise model used.',
    fields: [
      {
        key: 'simulationType',
        label: 'Simulation type',
        kind: 'enum',
        options: ['laminar', 'RAS', 'LES'],
        help: 'Modelling approach; RAS/LES require the matching sub-dictionary.',
        example: 'RAS',
      },
    ],
    subDicts: [
      {
        key: 'RAS',
        label: 'RAS (RANS) settings',
        help: 'Reynolds-Averaged Simulation model selection and switches.',
        fields: [
          {
            key: 'RASModel',
            label: 'RAS model',
            kind: 'enum',
            options: [
              'kEpsilon',
              'realizableKE',
              'RNGkEpsilon',
              'LaunderSharmaKE',
              'kOmega',
              'kOmegaSST',
              'kOmegaSSTLM',
              'kOmegaSSTSAS',
              'SpalartAllmaras',
              'LamBremhorstKE',
              'LienCubicKE',
              'qZeta',
              'kkLOmega',
              'v2f',
              'buoyantKEpsilon',
              'LRR',
              'SSG',
            ],
            help: 'Incompressible RANS model; LRR/SSG are Reynolds-stress (RSM) variants.',
            example: 'kOmegaSST',
          },
          {
            key: 'turbulence',
            label: 'Turbulence',
            kind: 'bool',
            options: ['on', 'off'],
            help: 'Enables or disables the turbulence calculation.',
            example: 'on',
          },
          {
            key: 'printCoeffs',
            label: 'Print coefficients',
            kind: 'bool',
            options: ['on', 'off'],
            help: 'Prints the model coefficients at start-up.',
            example: 'on',
          },
        ],
      },
      {
        key: 'LES',
        label: 'LES settings',
        help: 'Large Eddy Simulation model, filter-width (delta) and switches.',
        fields: [
          {
            key: 'LESModel',
            label: 'LES model',
            kind: 'enum',
            options: [
              'Smagorinsky',
              'dynamicKEqn',
              'kEqn',
              'WALE',
              'dynamicLagrangian',
              'DeardorffDiffStress',
              'SpalartAllmarasDDES',
              'SpalartAllmarasDES',
              'SpalartAllmarasIDDES',
            ],
            help: 'Sub-grid-scale (SGS) model.',
            example: 'WALE',
          },
          {
            key: 'turbulence',
            label: 'Turbulence',
            kind: 'bool',
            options: ['on', 'off'],
            help: 'Enables or disables the turbulence calculation.',
            example: 'on',
          },
          {
            key: 'printCoeffs',
            label: 'Print coefficients',
            kind: 'bool',
            options: ['on', 'off'],
            help: 'Prints the model coefficients at start-up.',
            example: 'on',
          },
          {
            key: 'delta',
            label: 'Filter width (delta)',
            kind: 'enum',
            options: [
              'cubeRootVol',
              'smooth',
              'Prandtl',
              'vanDriest',
              'maxDeltaxyz',
              'IDDESDelta',
            ],
            help: 'Filter-width model; reads coefficients from a `<delta>Coeffs` sub-dictionary.',
            example: 'cubeRootVol',
          },
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // system/
  // ─────────────────────────────────────────────────────────────────────────
  {
    object: 'controlDict',
    title: 'Run control (controlDict)',
    description:
      'Master file: solver, time/iteration control, write frequency and format, and post-processing.',
    fields: [
      {
        key: 'application',
        label: 'Application (solver)',
        kind: 'enum',
        options: [
          'simpleFoam',
          'pimpleFoam',
          'pisoFoam',
          'icoFoam',
          'interFoam',
          'rhoSimpleFoam',
          'buoyantSimpleFoam',
          'potentialFoam',
        ],
        help: 'Name of the solver executable; the list is extensible to any OpenFOAM solver.',
        example: 'simpleFoam',
      },
      {
        key: 'startFrom',
        label: 'Start from',
        kind: 'enum',
        options: ['firstTime', 'startTime', 'latestTime'],
        help: 'Where to begin: first available time / `startTime` value / latest time directory.',
        example: 'latestTime',
      },
      {
        key: 'startTime',
        label: 'Start time',
        kind: 'scalar',
        help: 'Start instant, used only when `startFrom` is `startTime`.',
        example: '0',
      },
      {
        key: 'stopAt',
        label: 'Stop at',
        kind: 'enum',
        options: ['endTime', 'writeNow', 'noWriteNow', 'nextWrite'],
        help: 'Stop criterion: at `endTime`, immediately (with/without write), or at the next write.',
        example: 'endTime',
      },
      {
        key: 'endTime',
        label: 'End time',
        kind: 'scalar',
        help: 'Final instant (or iteration count for a steady solver).',
        example: '2000',
      },
      {
        key: 'deltaT',
        label: 'Time step (deltaT)',
        kind: 'scalar',
        help: 'Time step (or iteration increment for a steady solver).',
        example: '1',
      },
      {
        key: 'writeControl',
        label: 'Write control',
        kind: 'enum',
        options: [
          'timeStep',
          'runTime',
          'adjustableRunTime',
          'cpuTime',
          'clockTime',
        ],
        help: 'What drives writing: step count / simulated time / adjustable time / CPU / wall-clock.',
        example: 'timeStep',
      },
      {
        key: 'writeInterval',
        label: 'Write interval',
        kind: 'scalar',
        help: 'Interval between writes, in the unit set by `writeControl`.',
        example: '50',
      },
      {
        key: 'purgeWrite',
        label: 'Purge write',
        kind: 'integer',
        help: 'Number of time directories kept in rotation (`0` keeps all).',
        example: '0',
      },
      {
        key: 'writeFormat',
        label: 'Write format',
        kind: 'enum',
        options: ['ascii', 'binary'],
        help: 'Field write format; binary is faster and smaller.',
        example: 'binary',
      },
      {
        key: 'writePrecision',
        label: 'Write precision',
        kind: 'integer',
        help: 'Number of significant digits written.',
        example: '6',
      },
      {
        key: 'writeCompression',
        label: 'Write compression',
        kind: 'bool',
        options: ['on', 'off'],
        help: 'gzip compression of written files (also accepts true/false, yes/no).',
        example: 'off',
      },
      {
        key: 'timeFormat',
        label: 'Time format',
        kind: 'enum',
        options: ['general', 'fixed', 'scientific'],
        help: 'Formatting of time-directory names.',
        example: 'general',
      },
      {
        key: 'timePrecision',
        label: 'Time precision',
        kind: 'integer',
        help: 'Precision of time-directory names.',
        example: '6',
      },
      {
        key: 'graphFormat',
        label: 'Graph format',
        kind: 'enum',
        options: ['raw', 'gnuplot', 'xmgr', 'jplot'],
        help: 'Format of generated graph files (e.g. residuals).',
        example: 'raw',
      },
      {
        key: 'runTimeModifiable',
        label: 'Run-time modifiable',
        kind: 'bool',
        options: ['true', 'false'],
        help: 'Re-reads dictionaries each step so they can be edited mid-run (also yes/no).',
        example: 'true',
      },
      {
        key: 'adjustTimeStep',
        label: 'Adjust time step',
        kind: 'bool',
        options: ['yes', 'no'],
        help: 'Adaptive time stepping (transient solvers only; also true/false).',
        example: 'no',
      },
      {
        key: 'maxCo',
        label: 'Max Courant number',
        kind: 'scalar',
        help: 'Target maximum Courant number (transient solvers only).',
        example: '1.5',
      },
      {
        key: 'maxDeltaT',
        label: 'Max time step',
        kind: 'scalar',
        help: 'Maximum allowed time step (transient solvers only).',
        example: '1',
      },
    ],
  },
  {
    object: 'decomposeParDict',
    title: 'Parallel decomposition (decomposeParDict)',
    description:
      'Defines how the mesh and fields are split into sub-domains for parallel (MPI) execution.',
    fields: [
      {
        key: 'numberOfSubdomains',
        label: 'Number of sub-domains',
        kind: 'integer',
        help: 'Number of sub-domains = number of parallel (MPI) processes.',
        example: '22',
      },
      {
        key: 'method',
        label: 'Decomposition method',
        kind: 'enum',
        options: [
          'scotch',
          'simple',
          'hierarchical',
          'manual',
          'metis',
          'kahip',
          'multiLevel',
          'structured',
          'none',
        ],
        help: 'Decomposition algorithm; `scotch` is automatic and needs no coefficients.',
        example: 'scotch',
      },
      {
        key: 'distributed',
        label: 'Distributed data',
        kind: 'bool',
        options: ['yes', 'no'],
        help: 'Whether data is distributed across several disks/machines.',
        example: 'no',
      },
    ],
  },
  {
    object: 'fvSchemes',
    title: 'Discretisation schemes (fvSchemes)',
    description:
      'Finite-volume discretisation schemes for time, gradient, divergence, Laplacian, interpolation and surface-normal gradient.',
    fields: [],
    subDicts: [
      {
        key: 'ddtSchemes',
        label: 'Time schemes (ddtSchemes)',
        help: 'Time-derivative discretisation; use `steadyState` for SIMPLE.',
        fields: [
          {
            key: 'default',
            label: 'Default scheme',
            kind: 'enum',
            options: [
              'steadyState',
              'Euler',
              'backward',
              'CrankNicolson',
              'localEuler',
              'bounded Euler',
            ],
            help: 'Default time scheme; per-term entries use the same options.',
            example: 'steadyState',
          },
        ],
      },
      {
        key: 'gradSchemes',
        label: 'Gradient schemes (gradSchemes)',
        help: 'Gradient discretisation; per-term entries like grad(U) use the same options.',
        fields: [
          {
            key: 'default',
            label: 'Default scheme',
            kind: 'enum',
            options: [
              'Gauss linear',
              'leastSquares',
              'pointCellsLeastSquares',
              'edgeCellsLeastSquares',
              'Gauss cubic',
              'Gauss skewCorrected linear',
              'cellLimited Gauss linear 1',
              'faceLimited Gauss linear 1',
              'cellMDLimited Gauss linear 1',
              'faceMDLimited Gauss linear 1',
            ],
            help: 'Default gradient scheme; per-term entries (e.g. grad(U)) use the same options.',
            example: 'Gauss linear',
          },
        ],
      },
      {
        key: 'divSchemes',
        label: 'Divergence schemes (divSchemes)',
        help: 'Convection/divergence discretisation; per-term entries like div(phi,U) use the same options.',
        fields: [
          {
            key: 'default',
            label: 'Default scheme',
            kind: 'enum',
            options: [
              'none',
              'Gauss linear',
              'Gauss upwind',
              'Gauss linearUpwind grad(U)',
              'Gauss LUST grad(U)',
              'Gauss limitedLinear 1',
              'Gauss vanLeer',
              'Gauss vanLeerV',
              'Gauss Minmod',
              'Gauss MUSCL',
              'Gauss SuperBee',
              'Gauss UMIST',
              'Gauss Gamma 1',
              'Gauss SFCD',
              'Gauss limitedLinear01 1',
              'Gauss vanLeer01',
              'Gauss interfaceCompression',
              'bounded Gauss upwind',
              'bounded Gauss linearUpwind grad(U)',
            ],
            help: 'Default divergence scheme; per-term entries (e.g. div(phi,U)) use the same options.',
            example: 'none',
          },
        ],
      },
      {
        key: 'laplacianSchemes',
        label: 'Laplacian schemes (laplacianSchemes)',
        help: 'Laplacian discretisation with a non-orthogonality correction; per-term entries use the same options.',
        fields: [
          {
            key: 'default',
            label: 'Default scheme',
            kind: 'enum',
            options: [
              'Gauss linear orthogonal',
              'Gauss linear corrected',
              'Gauss linear uncorrected',
              'Gauss linear limited corrected 0.333',
              'Gauss linear limited corrected 0.5',
              'Gauss linear limited corrected 1',
              'Gauss linear bounded',
            ],
            help: 'Default Laplacian scheme; per-term entries use the same options.',
            example: 'Gauss linear limited corrected 0.5',
          },
        ],
      },
      {
        key: 'interpolationSchemes',
        label: 'Interpolation schemes (interpolationSchemes)',
        help: 'Cell-to-face interpolation; per-term entries use the same options.',
        fields: [
          {
            key: 'default',
            label: 'Default scheme',
            kind: 'enum',
            options: [
              'linear',
              'cubic',
              'midPoint',
              'upwind',
              'linearUpwind',
              'skewCorrected linear',
              'harmonic',
              'pointLinear',
            ],
            help: 'Default interpolation scheme; per-term entries use the same options.',
            example: 'linear',
          },
        ],
      },
      {
        key: 'snGradSchemes',
        label: 'Surface-normal gradient (snGradSchemes)',
        help: 'Surface-normal gradient; should be aligned with laplacianSchemes. Per-term entries use the same options.',
        fields: [
          {
            key: 'default',
            label: 'Default scheme',
            kind: 'enum',
            options: [
              'orthogonal',
              'corrected',
              'uncorrected',
              'limited corrected 0.333',
              'limited corrected 0.5',
              'limited corrected 1',
              'bounded',
            ],
            help: 'Default surface-normal gradient scheme; per-term entries use the same options.',
            example: 'limited corrected 0.5',
          },
        ],
      },
      {
        key: 'wallDist',
        label: 'Wall distance (wallDist)',
        help: 'Wall-distance method, required by k-omega SST.',
        fields: [
          {
            key: 'method',
            label: 'Method',
            kind: 'enum',
            options: [
              'meshWave',
              'Poisson',
              'advectionDiffusion',
              'directionalMeshWave',
            ],
            help: 'Wall-distance computation method.',
            example: 'meshWave',
          },
        ],
      },
    ],
  },
  {
    object: 'fvSolution',
    title: 'Linear solvers & algorithm (fvSolution)',
    description:
      'Configures the linear solvers (one per field), the pressure-velocity coupling algorithm and the under-relaxation factors.',
    fields: [],
    subDicts: [
      {
        key: 'solvers',
        label: 'Linear solvers (solvers)',
        help: 'One sub-dictionary per field (p, U, k, …); these are the representative keywords.',
        fields: [
          {
            key: 'solver',
            label: 'Solver',
            kind: 'enum',
            options: [
              'GAMG',
              'PCG',
              'PBiCG',
              'PBiCGStab',
              'smoothSolver',
              'diagonalSolver',
            ],
            help: 'Linear solver: GAMG for pressure, smoothSolver for transported fields.',
            example: 'GAMG',
          },
          {
            key: 'preconditioner',
            label: 'Preconditioner',
            kind: 'enum',
            options: ['DIC', 'FDIC', 'DILU', 'GAMG', 'diagonal', 'none'],
            help: 'Preconditioner for PCG/PBiCG/PBiCGStab (DIC symmetric, DILU asymmetric).',
            example: 'DIC',
          },
          {
            key: 'smoother',
            label: 'Smoother',
            kind: 'enum',
            options: [
              'GaussSeidel',
              'symGaussSeidel',
              'DIC',
              'DICGaussSeidel',
              'DILU',
              'DILUGaussSeidel',
              'nonBlockingGaussSeidel',
              'FDIC',
            ],
            help: 'Smoother for GAMG/smoothSolver.',
            example: 'GaussSeidel',
          },
          {
            key: 'tolerance',
            label: 'Tolerance',
            kind: 'scalar',
            help: 'Target absolute residual (e.g. 1e-6 to 1e-8).',
            example: '1e-07',
          },
          {
            key: 'relTol',
            label: 'Relative tolerance',
            kind: 'scalar',
            help: 'Relative residual reduction per solve (`0` solves to `tolerance`).',
            example: '0.01',
          },
        ],
      },
      {
        key: 'SIMPLE',
        label: 'SIMPLE algorithm',
        help: 'Steady pressure-velocity coupling controls.',
        fields: [
          {
            key: 'nNonOrthogonalCorrectors',
            label: 'Non-orthogonal correctors',
            kind: 'integer',
            help: 'Non-orthogonality corrections per iteration (raise for skewed meshes).',
            example: '3',
          },
          {
            key: 'consistent',
            label: 'Consistent (SIMPLEC)',
            kind: 'bool',
            options: ['yes', 'no'],
            help: 'Enables SIMPLEC, which allows higher pressure relaxation.',
            example: 'yes',
          },
          {
            key: 'momentumPredictor',
            label: 'Momentum predictor',
            kind: 'bool',
            options: ['yes', 'no'],
            help: 'Solves the momentum predictor step.',
            example: 'yes',
          },
          {
            key: 'nCorrectors',
            label: 'Correctors',
            kind: 'integer',
            help: 'Number of pressure corrections (PISO/PIMPLE; not used by pure SIMPLE).',
            example: '2',
          },
          {
            key: 'pRefCell',
            label: 'Pressure reference cell',
            kind: 'integer',
            help: 'Reference cell index for pressure (closed incompressible flows).',
            example: '0',
          },
          {
            key: 'pRefValue',
            label: 'Pressure reference value',
            kind: 'scalar',
            help: 'Reference pressure value at the reference cell.',
            example: '0',
          },
        ],
      },
      {
        key: 'PIMPLE',
        label: 'PIMPLE algorithm',
        help: 'Transient pressure-velocity coupling (PISO + outer SIMPLE loops).',
        fields: [
          {
            key: 'nOuterCorrectors',
            label: 'Outer correctors',
            kind: 'integer',
            help: 'Number of outer loops (`1` reduces PIMPLE to PISO).',
            example: '1',
          },
          {
            key: 'nCorrectors',
            label: 'Correctors',
            kind: 'integer',
            help: 'Number of pressure corrections per outer loop.',
            example: '2',
          },
          {
            key: 'nNonOrthogonalCorrectors',
            label: 'Non-orthogonal correctors',
            kind: 'integer',
            help: 'Non-orthogonality corrections per pressure solve.',
            example: '1',
          },
          {
            key: 'momentumPredictor',
            label: 'Momentum predictor',
            kind: 'bool',
            options: ['yes', 'no'],
            help: 'Solves the momentum predictor step.',
            example: 'yes',
          },
        ],
      },
      {
        key: 'PISO',
        label: 'PISO algorithm',
        help: 'Transient pressure-velocity coupling for a single outer loop.',
        fields: [
          {
            key: 'nCorrectors',
            label: 'Correctors',
            kind: 'integer',
            help: 'Number of pressure corrections per time step.',
            example: '2',
          },
          {
            key: 'nNonOrthogonalCorrectors',
            label: 'Non-orthogonal correctors',
            kind: 'integer',
            help: 'Non-orthogonality corrections per pressure solve.',
            example: '0',
          },
          {
            key: 'pRefCell',
            label: 'Pressure reference cell',
            kind: 'integer',
            help: 'Reference cell index for pressure (closed incompressible flows).',
            example: '0',
          },
          {
            key: 'pRefValue',
            label: 'Pressure reference value',
            kind: 'scalar',
            help: 'Reference pressure value at the reference cell.',
            example: '0',
          },
        ],
      },
      {
        key: 'relaxationFactors',
        label: 'Relaxation factors',
        help: 'Under-relaxation, split into `fields { … }` (e.g. p) and `equations { … }` (e.g. U, k, omega); typically 0.3-0.9, freeform per field.',
        fields: [],
      },
    ],
  },
];
