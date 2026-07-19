interface BrandLogoProps {
  compact?: boolean
  inverse?: boolean
}

export const BrandLogo = ({ compact = false, inverse = false }: BrandLogoProps) => (
  <div className={`brand-logo ${compact ? 'brand-logo--compact' : ''} ${inverse ? 'brand-logo--inverse' : ''}`}>
    <span className="brand-logo__mark">
      <img src={`${import.meta.env.BASE_URL}logo-igea.png`} alt="" />
    </span>
    {!compact && (
      <span className="brand-logo__copy">
        <strong>Gestionale Igea</strong>
        <small>Ordini professionali</small>
      </span>
    )}
  </div>
)
