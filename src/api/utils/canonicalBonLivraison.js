/**
 * One e-commerce order IS the bon de livraison (type=ADVANCED).
 * STANDARD rows with sourceOrderId are leftover clones and must not
 * appear as a second document in lists, situation, or payments.
 */
export const CANONICAL_BL_WHERE = {
  OR: [{ type: "ADVANCED" }, { type: "STANDARD", sourceOrderId: null }],
};

export const canonicalBonLivraisonFilter = (extra = {}) => ({
  is: {
    ...CANONICAL_BL_WHERE,
    ...extra,
  },
});
