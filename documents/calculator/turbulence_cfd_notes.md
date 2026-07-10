# Turbulence — Notes CFD

## Définitions

- **k** — turbulent kinetic energy. Energy contained in the velocity fluctuations.
- **ε** — turbulent dissipation rate. The rate that converts k to heat.
- **ω** — specific dissipation rate. The rate of dissipation per turbulent energy.

## Paramètres

- **I** — turbulent intensity — usually around 5%
- **L** — length scale

## Calculation

1. $Re = \dfrac{U \cdot D_h}{\nu}$ — $D_h$ → characteristic length, can be anything

2. $I = 0.05 \times Re$

3. $k = \dfrac{3}{2}\,(U \cdot I)^2$

4. $L = 0.07 \times D_h$

5. $\omega = \dfrac{k^{0.5}}{0.09^{0.75} \cdot L} = \dfrac{\varepsilon}{k}$

6. $\varepsilon = \dfrac{k^{1.5}}{0.09^{0.75} \cdot L}$

⇒ Variables are $D_h$, $\nu$ and $U$
