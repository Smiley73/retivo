/**
 * Household member shape for chart tooltips' "<First> (age N)" rows; the age is `pointYear - birthYear`, matching the
 * life-expectancy markers.
 */
export interface TooltipMember {
  firstName: string;
  birthYear: number;
}
